import type { components } from "./generated.js";
import type { components as redmineComponents } from "./redmine-gateway.generated.js";

export const feedbackApiVersion = "1.0" as const;
export const feedbackApiMajorVersion = 1 as const;
export const feedbackManifestSchemaVersion = "1" as const;
export const feedbackTargetSchemaVersion = "1" as const;
export const feedbackRedmineContractVersion = "1" as const;

export type FeedbackCapabilities = components["schemas"]["FeedbackCapabilities"];
export type FeedbackHostContextV1 = components["schemas"]["FeedbackHostContextV1"];
export type FeedbackApplicationManifestV1 = components["schemas"]["FeedbackApplicationManifestV1"];
export type FeedbackLocationV1 = components["schemas"]["FeedbackLocationV1"];
export type FeedbackTargetV1 = components["schemas"]["FeedbackTargetV1"];
export type FeedbackReviewContextV1 = components["schemas"]["FeedbackReviewContextV1"];
export type FeedbackParticipant = components["schemas"]["FeedbackParticipant"];
export type FeedbackProblem = components["schemas"]["FeedbackProblem"];
export type FeedbackSessionV1 = components["schemas"]["FeedbackSessionV1"];
export type FeedbackThreadV1 = components["schemas"]["FeedbackThreadV1"];
export type FeedbackMessageV1 = components["schemas"]["FeedbackMessageV1"];

export type RedmineClientProfileV1 = redmineComponents["schemas"]["ClientProfile"];
export type RedmineCapabilitiesV1 = redmineComponents["schemas"]["Capabilities"];
export type RedmineCurrentPrincipalV1 = redmineComponents["schemas"]["Principal"];
export type RedmineThreadSummaryV1 = redmineComponents["schemas"]["ThreadSummary"];
export type RedmineThreadV1 = redmineComponents["schemas"]["Thread"];
export type RedmineAttachmentV1 = redmineComponents["schemas"]["Attachment"];
export type RedmineConversationMessageV1 = redmineComponents["schemas"]["ConversationMessage"];
export type RedmineParticipantResultV1 = redmineComponents["schemas"]["ParticipantResult"];
export type RedmineCreateThreadRequestV1 = redmineComponents["schemas"]["CreateThreadRequest"];
export type RedmineCreateMessageRequestV1 = redmineComponents["schemas"]["CreateMessageRequest"];
export type RedmineUpdateMessageRequestV1 = redmineComponents["schemas"]["UpdateMessageRequest"];
export type RedmineProblemV1 = redmineComponents["schemas"]["Problem"];

export type { components, operations, paths } from "./generated.js";
export type {
  components as redmineComponents,
  operations as redmineOperations,
  paths as redminePaths
} from "./redmine-gateway.generated.js";
