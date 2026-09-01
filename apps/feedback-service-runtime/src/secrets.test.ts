import { describe, expect, it } from "vitest";
import { loadFeedbackEnvelopeCodec, participantIdForAuthorization, resolveProviderAuthorization } from "./secrets.js";

const key = Buffer.alloc(32, 9).toString("base64url");
const resolver = {
  async resolve(id: string) {
    if (id === "RING") return JSON.stringify({ activeKid: "new", keys: [{ kid: "new", key }, { kid: "old", key: Buffer.alloc(32, 8).toString("base64url") }] });
    if (id === "JIRA") return JSON.stringify({ kind: "jira-cloud-basic", email: "tester@example.test", apiToken: "secret-token" });
    if (id === "DERIVATION") return key;
    throw new Error("secretなし");
  }
};

describe("production secret parser", () => {
  it("key ringのactive／verify-only状態とJira Basic headerをsecret内で組み立てる", async () => {
    const codec = await loadFeedbackEnvelopeCodec(resolver, "RING");
    const envelope = await codec.signEnvelope({
      schemaVersion: "2",
      threadId: "018f0f58-c3d1-7a2b-8a4f-4c09571e6201",
      intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e6202",
      requestHash: `sha256:${"1".repeat(64)}`,
      providerBinding: { profileId: "profile", installationId: "site", objectId: "1" },
      scope: { workspace: "FBT", resource: { kind: "record", key: "1" }, application: "app", environment: "test" },
      createdBy: { participantId: "018f0f58-c3d1-7a2b-8a4f-4c09571e6203" },
      createdAt: "2026-09-01T00:00:00.000Z"
    });
    expect(envelope.signature.kid).toBe("new");
    await expect(resolveProviderAuthorization({ secretResolver: resolver, secretId: "JIRA", connectorKey: "jira-cloud" }))
      .resolves.toBe(`Basic ${Buffer.from("tester@example.test:secret-token").toString("base64")}`);
  });

  it("signed／remote subjectを分離鍵で安定UUIDへ導出し、生subjectをproviderへ渡さない", async () => {
    const decision = {
      mode: "signed-grant" as const,
      target: { level: "profile" as const, profileId: "profile" },
      subjectId: "opaque-user-123",
      allowedOperations: ["feedback:read" as const]
    };
    const first = await participantIdForAuthorization({
      decision,
      publicParticipantId: null,
      profileId: "profile",
      derivationSecretId: "DERIVATION",
      secretResolver: resolver
    });
    const second = await participantIdForAuthorization({
      decision,
      publicParticipantId: null,
      profileId: "profile",
      derivationSecretId: "DERIVATION",
      secretResolver: resolver
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f-]{36}$/u);
    expect(first).not.toContain(decision.subjectId);
  });
});
