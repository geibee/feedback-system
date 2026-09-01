import type { FeedbackConnectorContractFixture } from "@geibee/feedback-connector-sdk/testing";

/** Phase 2のprovider実測とv1 conformanceから固定したRedmine能力。 */
export const redmineContractFixture = {
  schemaVersion: "feedback-connector-tck.v1",
  connectorKey: "redmine",
  capabilities: {
    backendOperations: [
      "feedback:read",
      "feedback:create",
      "feedback:reply",
      "feedback:revise",
      "feedback:attachment:read",
      "feedback:attachment:upload"
    ],
    discovery: { workspaces: "supported", resources: "supported" },
    operationGuarantees: {
      create: "recoverable",
      reply: "recoverable",
      revision: "best-effort",
      attachmentUpload: "best-effort"
    },
    creationFields: [],
    maximumAttachmentBytes: 5_242_880,
    attachmentContentTypes: ["application/octet-stream", "image/png", "text/plain"]
  },
  firstThreadWriteFields: ["threadId", "intentId", "requestHash"],
  uniqueThreadLookup: true,
  operations: {
    create: { guarantee: "recoverable", bodyAndIntentMarkerSingleWrite: true, providerBackedLookup: "unique" },
    reply: { guarantee: "recoverable", bodyAndIntentMarkerSingleWrite: true, providerBackedLookup: "eventual" },
    revision: { guarantee: "best-effort", bodyAndIntentMarkerSingleWrite: true, providerBackedLookup: "eventual" },
    attachmentUpload: {
      guarantee: "best-effort",
      bodyAndIntentMarkerSingleWrite: false,
      providerBackedLookup: "none",
      automaticBinaryRetry: false,
      signedProviderMapping: true
    }
  },
  searchMissDecision: "pending",
  multipleHitDecision: "repair_required"
} as const satisfies FeedbackConnectorContractFixture;
