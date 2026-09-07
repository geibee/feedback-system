import { describe, expect, it } from "vitest";
import { feedbackRepositoryContractVersion } from "./index.js";
import { assertFeedbackConnectorContractFixture, createFakeFeedbackRepository } from "./testing.js";

describe("FeedbackRepositoryPort契約", () => {
  it("Contract freeze候補versionを明示する", () => {
    expect(feedbackRepositoryContractVersion).toBe("2-alpha.1");
  });

  it("fake repositoryがscopeと呼出回数を記録する", async () => {
    const repository = createFakeFeedbackRepository({
      async findThreadCandidatesById(query) {
        expect(query.threadId).toBe("018f0f58-c3d1-7a2b-8a4f-4c09571e5001");
        return [];
      }
    });
    await repository.findThreadCandidatesById({
      profileId: "inventory",
      installationId: "redmine-local",
      workspaceId: "OPS",
      resource: { kind: "record", key: "order-001" },
      threadId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5001"
    });
    expect(repository.count("findThreadCandidatesById")).toBe(1);
  });

  it("recoverableの根拠不足とbinary自動再送をTCKで拒否する", () => {
    const base = {
      schemaVersion: "feedback-connector-tck.v1" as const,
      connectorKey: "invalid",
      capabilities: {
        backendOperations: ["feedback:create" as const],
        discovery: { workspaces: "unsupported" as const, resources: "unsupported" as const },
        operationGuarantees: { create: "recoverable" as const, reply: "unsupported" as const, revision: "unsupported" as const, attachmentUpload: "best-effort" as const },
        creationFields: [],
        maximumAttachmentBytes: 0,
        attachmentContentTypes: []
      },
      firstThreadWriteFields: ["threadId", "intentId", "requestHash"],
      uniqueThreadLookup: true,
      operations: {
        create: { guarantee: "recoverable" as const, bodyAndIntentMarkerSingleWrite: false, providerBackedLookup: "unique" as const },
        reply: { guarantee: "unsupported" as const, bodyAndIntentMarkerSingleWrite: false, providerBackedLookup: "none" as const },
        revision: { guarantee: "unsupported" as const, bodyAndIntentMarkerSingleWrite: false, providerBackedLookup: "none" as const },
        attachmentUpload: { guarantee: "best-effort" as const, bodyAndIntentMarkerSingleWrite: false, providerBackedLookup: "none" as const, automaticBinaryRetry: false, signedProviderMapping: false }
      },
      searchMissDecision: "pending" as const,
      multipleHitDecision: "repair_required" as const
    };
    expect(() => assertFeedbackConnectorContractFixture(base)).toThrow(/recoverable/);
    expect(() => assertFeedbackConnectorContractFixture({
      ...base,
      operations: {
        ...base.operations,
        create: { ...base.operations.create, bodyAndIntentMarkerSingleWrite: true },
        attachmentUpload: { ...base.operations.attachmentUpload, automaticBinaryRetry: true }
      }
    })).toThrow(/自動再送/);
  });
});
