import type { FeedbackConnectorContractFixture } from "@geibee/feedback-connector-sdk/testing";

/** Phase 2 Jira Cloud contract spikeから固定した能力。 */
export const jiraCloudContractFixture = {
  schemaVersion: "feedback-connector-tck.v1",
  connectorKey: "jira-cloud",
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
    maximumAttachmentBytes: 1_073_741_824,
    attachmentContentTypes: ["application/octet-stream", "image/png", "text/plain"]
  },
  firstThreadWriteFields: ["threadId", "intentId", "requestHash"],
  uniqueThreadLookup: true,
  operations: {
    create: { guarantee: "recoverable", bodyAndIntentMarkerSingleWrite: true, providerBackedLookup: "eventual" },
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
