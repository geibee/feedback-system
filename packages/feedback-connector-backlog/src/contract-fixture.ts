import type { FeedbackConnectorContractFixture } from "@geibee/feedback-connector-sdk/testing";

/** Backlog SaaS Stage A live Gateから固定した能力。 */
export const backlogContractFixture = {
  schemaVersion: "feedback-connector-tck.v1",
  connectorKey: "backlog",
  capabilities: {
    backendOperations: ["feedback:read", "feedback:create", "feedback:reply", "feedback:revise"],
    discovery: { workspaces: "supported", resources: "unsupported" },
    operationGuarantees: { create: "recoverable", reply: "recoverable", revision: "recoverable", attachmentUpload: "unsupported" },
    creationFields: [],
    maximumAttachmentBytes: 1,
    attachmentContentTypes: []
  },
  firstThreadWriteFields: ["threadId", "intentId", "requestHash"],
  uniqueThreadLookup: true,
  operations: {
    create: { guarantee: "recoverable", bodyAndIntentMarkerSingleWrite: true, providerBackedLookup: "eventual" },
    reply: { guarantee: "recoverable", bodyAndIntentMarkerSingleWrite: true, providerBackedLookup: "eventual" },
    revision: { guarantee: "recoverable", bodyAndIntentMarkerSingleWrite: true, providerBackedLookup: "eventual" },
    attachmentUpload: {
      guarantee: "unsupported",
      bodyAndIntentMarkerSingleWrite: false,
      providerBackedLookup: "none",
      automaticBinaryRetry: false,
      signedProviderMapping: false
    }
  },
  searchMissDecision: "pending",
  multipleHitDecision: "repair_required"
} as const satisfies FeedbackConnectorContractFixture;
