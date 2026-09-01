import { describe, expect, it } from "vitest";
import type { FeedbackProviderProfileV2 } from "@geibee/feedback-contracts/v2/server";
import { createFakeFeedbackProfileLoader } from "./index.js";

const profile: FeedbackProviderProfileV2 = {
  schemaVersion: "2",
  profileId: "inventory-production",
  displayName: "Inventory / Production",
  connectorKey: "jira-cloud",
  installationId: "jira-site-1",
  workspacePolicy: {
    workspaceIds: ["OPS"],
    workspaceDiscovery: "supported",
    resourceDiscovery: "supported"
  },
  authorization: { mode: "signed-grant", issuerProfileRef: "inventory-issuer" },
  policy: {
    operations: ["feedback:read", "feedback:create", "feedback:attachment:upload"],
    resourceKinds: ["record"]
  },
  capabilities: {
    operations: ["feedback:read", "feedback:create", "feedback:attachment:upload"],
    discovery: { workspaces: "supported", resources: "supported" },
    operationGuarantees: {
      create: "recoverable",
      reply: "unsupported",
      revision: "unsupported",
      attachmentUpload: "best-effort"
    },
    creationFields: [],
    maximumMetadataBytes: 32768,
    projectionValidation: "envelope-required",
    uniqueThreadLookup: true
  },
  secretRefs: {
    providerCredential: { kind: "server-secret", id: "FEEDBACK_JIRA_CLOUD_CREDENTIAL" },
    envelopeKeyRing: { kind: "server-secret", id: "FEEDBACK_ENVELOPE_KEY_RING" },
    participantCredentialKeyRing: { kind: "server-secret", id: "FEEDBACK_PARTICIPANT_CREDENTIAL_KEY_RING" },
    participantIdDerivationKey: { kind: "server-secret", id: "FEEDBACK_PARTICIPANT_ID_DERIVATION_KEY" }
  }
};

describe("fake provider profile loader", () => {
  it("profileの固定modeをそのまま返す", async () => {
    const loader = createFakeFeedbackProfileLoader([profile]);
    const loaded = await loader.loadProfiles();
    expect(loaded[0]?.authorization.mode).toBe("signed-grant");
    expect(Object.isFrozen(loaded[0])).toBe(true);
  });

  it("同じprofile IDのmode分岐を起動前に拒否する", () => {
    expect(() => createFakeFeedbackProfileLoader([
      profile,
      { ...profile, authorization: { mode: "public-profile" } }
    ])).toThrow("provider profile IDが重複");
  });
});
