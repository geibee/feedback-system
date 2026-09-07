import type { FeedbackProviderProfileV2 } from "@geibee/feedback-contracts/v2/server";
import { describe, expect, it } from "vitest";
import {
  assertCurrentParticipantOwnsMessage,
  assertParticipantOwnsMessage,
  issueFeedbackParticipantCredential,
  verifyFeedbackParticipantCredential
} from "./participant.js";

const profile: FeedbackProviderProfileV2 = {
  schemaVersion: "2", profileId: "public", displayName: "Public", connectorKey: "fake", installationId: "fake",
  workspacePolicy: { workspaceIds: ["OPS"], workspaceDiscovery: "supported", resourceDiscovery: "supported" },
  authorization: { mode: "public-profile" },
  policy: { operations: ["feedback:read", "feedback:create", "feedback:reply", "feedback:revise"], resourceKinds: ["record"] },
  capabilities: {
    operations: ["feedback:read", "feedback:create", "feedback:reply", "feedback:revise"],
    discovery: { workspaces: "supported", resources: "supported" },
    operationGuarantees: { create: "recoverable", reply: "recoverable", revision: "best-effort", attachmentUpload: "unsupported" },
    creationFields: [], maximumMetadataBytes: 32768, projectionValidation: "envelope-required", uniqueThreadLookup: true
  },
  secretRefs: {
    providerCredential: { kind: "server-secret", id: "PROVIDER" }, envelopeKeyRing: { kind: "server-secret", id: "ENVELOPE" },
    participantCredentialKeyRing: { kind: "server-secret", id: "PARTICIPANT_RING" }, participantIdDerivationKey: { kind: "server-secret", id: "DERIVATION" }
  }
};

const key1 = Buffer.alloc(32, 1).toString("base64url");
const key2 = Buffer.alloc(32, 2).toString("base64url");
const derivation = Buffer.alloc(32, 3).toString("base64url");

describe("v2 participant credential", () => {
  it("credential署名鍵rotation後も分離した導出鍵によりparticipant IDを維持する", async () => {
    let ring = JSON.stringify({ activeKid: "old", keys: [{ kid: "old", key: key1 }] });
    const resolver = { async resolve(id: string) { return id === "PARTICIPANT_RING" ? ring : derivation; } };
    const issued = await issueFeedbackParticipantCredential({
      profile,
      browserProfileId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5201",
      origin: "https://app.example",
      secretResolver: resolver,
      now: () => new Date("2026-09-01T00:00:00.000Z")
    });
    ring = JSON.stringify({ activeKid: "new", keys: [{ kid: "new", key: key2 }, { kid: "old", key: key1 }] });
    const verified = await verifyFeedbackParticipantCredential({
      profile, credential: issued.credential, origin: "https://app.example", secretResolver: resolver,
      now: () => new Date("2026-09-01T00:00:01.000Z")
    });
    const rotated = await issueFeedbackParticipantCredential({
      profile,
      browserProfileId: verified.browserProfileId,
      origin: "https://app.example",
      secretResolver: resolver
    });
    expect(rotated.participantId).toBe(issued.participantId);
    expect(rotated.credential).not.toBe(issued.credential);
  });

  it("別origin／profileへのcredential replayを拒否する", async () => {
    const ring = JSON.stringify({ activeKid: "current", keys: [{ kid: "current", key: key1 }] });
    const resolver = { async resolve(id: string) { return id === "PARTICIPANT_RING" ? ring : derivation; } };
    const issued = await issueFeedbackParticipantCredential({
      profile, browserProfileId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5201", origin: "https://app.example", secretResolver: resolver
    });
    await expect(verifyFeedbackParticipantCredential({
      profile, credential: issued.credential, origin: "https://other.example", secretResolver: resolver
    })).rejects.toMatchObject({ code: "feedback.forbidden" });
  });

  it("30日+30秒を超えたcredentialと未来発行credentialを拒否する", async () => {
    const ring = JSON.stringify({ activeKid: "current", keys: [{ kid: "current", key: key1 }] });
    const resolver = { async resolve(id: string) { return id === "PARTICIPANT_RING" ? ring : derivation; } };
    const issued = await issueFeedbackParticipantCredential({
      profile,
      browserProfileId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5205",
      origin: "https://app.example",
      secretResolver: resolver,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });
    await expect(verifyFeedbackParticipantCredential({
      profile, credential: issued.credential, origin: "https://app.example", secretResolver: resolver,
      now: () => new Date("2026-01-31T00:00:31.000Z")
    })).rejects.toMatchObject({ code: "feedback.forbidden" });
    await expect(verifyFeedbackParticipantCredential({
      profile, credential: issued.credential, origin: "https://app.example", secretResolver: resolver,
      now: () => new Date("2025-12-31T23:59:29.000Z")
    })).rejects.toMatchObject({ code: "feedback.forbidden" });
  });

  it("自己投稿以外のrevisionを拒否する", () => {
    const participantId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5202";
    const thread = {
      threadId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5203",
      resource: { kind: "record", key: "order-001" }, title: "title", status: "open" as const,
      createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", messageCount: 1,
      messages: [{
        messageId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5204", body: "body",
        author: { kind: "participant" as const, participantId, displayName: "Participant", isCurrentParticipant: true },
        createdAt: "2026-09-01T00:00:00.000Z",
        orderingKey: { occurredAt: "2026-09-01T00:00:00.000Z", eventId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5204" },
        revisions: [], attachments: []
      }]
    };
    expect(() => assertParticipantOwnsMessage({ thread, messageId: thread.messages[0]!.messageId, participantId })).not.toThrow();
    expect(() => assertParticipantOwnsMessage({ thread, messageId: thread.messages[0]!.messageId, participantId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5299" }))
      .toThrow(/所有情報/);
  });

  it("signed／remote modeでも現在participantへ写像したmessageだけを自己編集対象にする", () => {
    const thread = {
      threadId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5210",
      resource: { kind: "record", key: "1" }, title: "title", status: "open" as const,
      createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", messageCount: 1,
      messages: [{
        messageId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5211", body: "body",
        author: { kind: "participant" as const, participantId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5212", displayName: "user", isCurrentParticipant: true },
        createdAt: "2026-09-01T00:00:00.000Z",
        orderingKey: { occurredAt: "2026-09-01T00:00:00.000Z", eventId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5211" },
        revisions: [], attachments: []
      }]
    };
    expect(() => assertCurrentParticipantOwnsMessage({ thread, messageId: thread.messages[0]!.messageId })).not.toThrow();
    thread.messages[0]!.author.isCurrentParticipant = false;
    expect(() => assertCurrentParticipantOwnsMessage({ thread, messageId: thread.messages[0]!.messageId })).toThrow(/現在participant所有情報/u);
  });
});
