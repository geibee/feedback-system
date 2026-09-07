import type { FeedbackProviderProfileV2 } from "@geibee/feedback-contracts/v2/server";
import { createFeedbackEnvelopeCodec } from "@geibee/feedback-envelope";
import { describe, expect, it } from "vitest";
import type { FeedbackConnectorCatalog, JiraCloudRuntimeProfile } from "./catalog.js";
import { createProductionFeedbackProjectionVerifier } from "./projection.js";

const resource = { kind: "record", key: "order-001" } as const;
const profile: FeedbackProviderProfileV2 = {
  schemaVersion: "2",
  profileId: "jira-production",
  displayName: "Jira Production",
  connectorKey: "jira-cloud",
  installationId: "site-1",
  connectorProfileRef: "jira-runtime",
  workspacePolicy: { workspaceIds: ["FBT"], workspaceDiscovery: "supported", resourceDiscovery: "supported" },
  authorization: { mode: "public-profile" },
  policy: { operations: ["feedback:read"], resourceKinds: ["record"] },
  capabilities: {
    operations: ["feedback:read"],
    discovery: { workspaces: "supported", resources: "supported" },
    operationGuarantees: { create: "recoverable", reply: "recoverable", revision: "best-effort", attachmentUpload: "best-effort" },
    creationFields: [],
    maximumMetadataBytes: 32768,
    projectionValidation: "envelope-required",
    uniqueThreadLookup: true
  },
  secretRefs: {
    providerCredential: { kind: "server-secret", id: "PROVIDER" },
    envelopeKeyRing: { kind: "server-secret", id: "ENVELOPE" },
    participantCredentialKeyRing: { kind: "server-secret", id: "PARTICIPANT" },
    participantIdDerivationKey: { kind: "server-secret", id: "DERIVATION" }
  }
};
const runtimeProfile: JiraCloudRuntimeProfile = {
  id: "jira-runtime",
  connectorKey: "jira-cloud",
  siteUrl: "https://example.atlassian.net",
  application: "inventory",
  environment: "production",
  issueTypeId: "10001",
  maximumAttachmentBytes: 1024,
  attachmentContentTypes: ["text/plain"],
  timeoutMilliseconds: 1000,
  pageSize: 50,
  recoveryRetryAfterSeconds: 10
};
const catalog: FeedbackConnectorCatalog = {
  schemaVersion: "1",
  profiles: new Map([[runtimeProfile.id, runtimeProfile]])
};
const oldKey = Uint8Array.from({ length: 32 }, () => 1);
const newKey = Uint8Array.from({ length: 32 }, () => 2);
const threadId = "018f0f58-c3d1-7a2b-8a4f-4c09571e6101";
const intentId = "018f0f58-c3d1-7a2b-8a4f-4c09571e6102";
const requestHash = `sha256:${"1".repeat(64)}`;

async function fixture() {
  const writer = createFeedbackEnvelopeCodec([{ kid: "old", secret: oldKey, state: "active" }]);
  const verifierCodec = createFeedbackEnvelopeCodec([
    { kid: "new", secret: newKey, state: "active" },
    { kid: "old", secret: oldKey, state: "verify-only" }
  ]);
  const envelope = await writer.signEnvelope({
    schemaVersion: "2",
    threadId,
    intentId,
    requestHash,
    providerBinding: { profileId: profile.profileId, installationId: profile.installationId, objectId: "10000" },
    scope: { workspace: "FBT", resource, application: "inventory", environment: "production" },
    createdBy: { participantId: "018f0f58-c3d1-7a2b-8a4f-4c09571e6103" },
    createdAt: "2026-09-01T00:00:00.000Z"
  });
  const candidate = {
    providerRef: { providerKey: "jira-cloud", objectId: "10000" },
    projection: { schemaVersion: "2" as const, threadId, intentId, requestHash, profileId: profile.profileId, workspaceId: "FBT", resource }
  };
  const record = {
    providerRef: candidate.providerRef,
    envelope,
    legacyMetadata: null,
    thread: {
      threadId,
      resource,
      title: "Feedback",
      status: "open" as const,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      messageCount: 0,
      messages: []
    }
  };
  const context = {
    profileId: profile.profileId,
    workspaceId: "FBT",
    resource,
    profile,
    authorization: {
      target: { level: "resource" as const, profileId: profile.profileId, workspaceId: "FBT", resource },
      mode: "public-profile" as const,
      allowedOperations: ["feedback:read" as const]
    }
  };
  const verifier = createProductionFeedbackProjectionVerifier({ catalog, async loadCodec() { return verifierCodec; } });
  return { verifier, candidate, record, context };
}

describe("production projection verifier", () => {
  it("verify-only旧鍵を受理し、再読込Envelopeと全scopeが一致したrecordだけを返す", async () => {
    const { verifier, candidate, record, context } = await fixture();
    await expect(verifier.verify(candidate, record, context)).resolves.toMatchObject({
      valid: true,
      record: { envelope: { signature: { kid: "old" } } }
    });
  });

  it("unknown kidとprovider binding差異をfail-closedにする", async () => {
    const { verifier, candidate, record, context } = await fixture();
    const unknownKid = structuredClone(record);
    (unknownKid.envelope as { signature: { kid: string } }).signature.kid = "unknown";
    await expect(verifier.verify(candidate, unknownKid, context)).resolves.toEqual({ valid: false, reason: "signature" });

    const rebound = { ...record, providerRef: { providerKey: "jira-cloud", objectId: "10001" } };
    await expect(verifier.verify(candidate, rebound, context)).resolves.toEqual({ valid: false, reason: "binding" });
  });

  it("projection、Envelope、requestのscope差異を返却しない", async () => {
    const { verifier, candidate, record, context } = await fixture();
    const otherCandidate = { ...candidate, projection: { ...candidate.projection, workspaceId: "OTHER" } };
    await expect(verifier.verify(otherCandidate, record, context)).resolves.toEqual({ valid: false, reason: "scope" });
  });

  it("Envelope key resolver障害を空一覧へ変換しない", async () => {
    const { candidate, record, context } = await fixture();
    const verifier = createProductionFeedbackProjectionVerifier({
      catalog,
      async loadCodec() { throw new Error("secret unavailable"); }
    });
    await expect(verifier.verify(candidate, record, context)).rejects.toMatchObject({
      code: "feedback.provider_unavailable",
      status: 502,
      retryable: true
    });
  });
});
