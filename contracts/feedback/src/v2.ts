import type { components as feedbackComponents } from "./feedback-gateway.generated.js";

export const feedbackContractVersion = "2" as const;

export type FeedbackOperationV2 = feedbackComponents["schemas"]["Operation"];
export type FeedbackOperationGuaranteeV2 = feedbackComponents["schemas"]["OperationGuarantee"];
export type FeedbackResourceRefV2 = feedbackComponents["schemas"]["ResourceRef"];
export type FeedbackOrderingKeyWireV2 = feedbackComponents["schemas"]["OrderingKey"];
export type FeedbackCreationFieldV2 = feedbackComponents["schemas"]["CreationField"];
export type FeedbackWorkspaceSummaryV2 = feedbackComponents["schemas"]["WorkspaceSummary"];
export type FeedbackResourceSummaryV2 = feedbackComponents["schemas"]["ResourceSummary"];
export type FeedbackCapabilitiesV2 = feedbackComponents["schemas"]["Capabilities"];
export type FeedbackProfileV2 = feedbackComponents["schemas"]["Profile"];
export type FeedbackCreateParticipantRequestV2 = feedbackComponents["schemas"]["CreateParticipantRequest"];
export type FeedbackParticipantCredentialResultV2 = feedbackComponents["schemas"]["ParticipantCredentialResult"];
export type FeedbackThreadSummaryV2 = feedbackComponents["schemas"]["ThreadSummary"];
export type FeedbackThreadV2 = feedbackComponents["schemas"]["Thread"];
export type FeedbackMessageV2 = feedbackComponents["schemas"]["Message"];
export type FeedbackAttachmentV2 = feedbackComponents["schemas"]["Attachment"];
export type FeedbackWorkspacePageV2 = feedbackComponents["schemas"]["WorkspacePage"];
export type FeedbackResourcePageV2 = feedbackComponents["schemas"]["ResourcePage"];
export type FeedbackThreadPageV2 = feedbackComponents["schemas"]["ThreadPage"];
export type FeedbackCreateThreadCommandV2 = feedbackComponents["schemas"]["CreateThreadCommand"];
export type FeedbackReplyCommandV2 = feedbackComponents["schemas"]["ReplyCommand"];
export type FeedbackAppendRevisionCommandV2 = feedbackComponents["schemas"]["AppendRevisionCommand"];
export type FeedbackUploadAttachmentCommandV2 = feedbackComponents["schemas"]["UploadAttachmentCommand"];
export type FeedbackThreadCommandResultV2 = feedbackComponents["schemas"]["ThreadCommandResult"];
export type FeedbackMessageCommandResultV2 = feedbackComponents["schemas"]["MessageCommandResult"];
export type FeedbackAttachmentCommandResultV2 = feedbackComponents["schemas"]["AttachmentCommandResult"];
export type FeedbackIntentRecoveryResultV2 = feedbackComponents["schemas"]["IntentRecoveryResult"];
export type FeedbackProblemV2 = feedbackComponents["schemas"]["Problem"];
export type FeedbackPageV2<T> = { items: T[]; nextCursor: string | null };

export type { FeedbackDomainV2, FeedbackOrderingKeyV2, FeedbackScopeV2 } from "./feedback-domain.generated.js";
export type {
  components as feedbackComponents,
  operations as feedbackOperations,
  paths as feedbackPaths
} from "./feedback-gateway.generated.js";
