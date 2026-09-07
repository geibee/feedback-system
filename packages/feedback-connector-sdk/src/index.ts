import type {
  FeedbackAttachmentCommandResultV2,
  FeedbackCapabilitiesV2,
  FeedbackCreateThreadCommandV2,
  FeedbackIntentRecoveryResultV2,
  FeedbackMessageCommandResultV2,
  FeedbackResourcePageV2,
  FeedbackResourceRefV2,
  FeedbackThreadCommandResultV2,
  FeedbackThreadV2,
  FeedbackUploadAttachmentCommandV2,
  FeedbackWorkspacePageV2,
  FeedbackReplyCommandV2,
  FeedbackAppendRevisionCommandV2
} from "@geibee/feedback-contracts/v2";
import type { FeedbackEnvelopeV2, FeedbackProjectionV2 } from "@geibee/feedback-contracts/v2/server";

export const feedbackRepositoryContractVersion = "2-alpha.1" as const;

export type ProviderRef = {
  providerKey: string;
  objectId: string;
  eventId?: string;
  canonicalUrl?: string;
};

export interface FeedbackAbortSignal {
  readonly aborted: boolean;
  subscribe(listener: () => void): () => void;
}

export type FeedbackRepositoryScope = {
  profileId: string;
  installationId: string;
  workspaceId: string;
  resource: FeedbackResourceRefV2;
};

export type FeedbackRepositoryOptions = {
  signal?: FeedbackAbortSignal;
  /** Serviceが復号・scope検証した参照。存在する場合は検索へfallbackしない。 */
  threadRef?: ProviderRef;
  /** 現在のEnvelope binding検証後だけ通知するserver内部port。 */
  onThreadResolved?: (reference: ProviderRef) => void;
};

export type FeedbackProjectionCandidate = {
  providerRef: ProviderRef;
  projection: FeedbackProjectionV2;
};

export type FeedbackRepositoryRecord = {
  providerRef: ProviderRef;
  envelope: FeedbackEnvelopeV2;
  thread: FeedbackThreadV2;
};

export type FeedbackRepositoryCandidateRead = {
  providerRef: ProviderRef;
  envelope: unknown | null;
  legacyMetadata: unknown | null;
  thread: FeedbackThreadV2;
};

export type FeedbackRecoverableOperation =
  | "feedback:create"
  | "feedback:reply"
  | "feedback:revise"
  | "feedback:attachment:upload";

export type FeedbackIntentRecoveryResultFor<TOperation extends FeedbackRecoverableOperation> =
  FeedbackIntentRecoveryResultV2 & { operation: TOperation };

export class FeedbackConnectorProblem extends Error {
  readonly code: "feedback.unsupported" | "feedback.not_found" | "feedback.conflict" | "feedback.integrity_error" |
    "feedback.provider_unavailable" | "feedback.provider_timeout" | "feedback.rate_limited";
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(input: {
    code: FeedbackConnectorProblem["code"];
    status: number;
    retryable: boolean;
    message: string;
    retryAfterSeconds?: number;
  }) {
    super(input.message);
    this.name = "FeedbackConnectorProblem";
    this.code = input.code;
    this.status = input.status;
    this.retryable = input.retryable;
    this.retryAfterSeconds = input.retryAfterSeconds;
  }
}

export interface FeedbackUploadStreamSource {
  readonly sizeBytes: number;
  read(): AsyncIterable<Uint8Array>;
}

export interface FeedbackDownloadStream {
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly body: AsyncIterable<Uint8Array>;
}

export interface FeedbackRepositoryPort {
  readonly supportsThreadReferences?: true;
  getCapabilities(options?: FeedbackRepositoryOptions): Promise<FeedbackCapabilitiesV2>;
  listWorkspaces(profileId: string, cursor?: string, options?: FeedbackRepositoryOptions): Promise<FeedbackWorkspacePageV2>;
  listResources(query: { profileId: string; workspaceId: string; query?: string; cursor?: string }, options?: FeedbackRepositoryOptions): Promise<FeedbackResourcePageV2>;
  findThreadCandidates(query: FeedbackRepositoryScope & { cursor?: string; order?: "updated_desc" | "updated_asc" }, options?: FeedbackRepositoryOptions): Promise<{ candidates: FeedbackProjectionCandidate[]; nextCursor: string | null }>;
  findThreadCandidatesById(query: FeedbackRepositoryScope & { threadId: string }, options?: FeedbackRepositoryOptions): Promise<FeedbackProjectionCandidate[]>;
  readCandidate(candidate: FeedbackProjectionCandidate, options?: FeedbackRepositoryOptions): Promise<FeedbackRepositoryCandidateRead>;
  createThread(query: FeedbackRepositoryScope & { command: FeedbackCreateThreadCommandV2 }, options?: FeedbackRepositoryOptions): Promise<FeedbackThreadCommandResultV2 | FeedbackIntentRecoveryResultFor<"feedback:create">>;
  reply(query: FeedbackRepositoryScope & { threadId: string; command: FeedbackReplyCommandV2 }, options?: FeedbackRepositoryOptions): Promise<FeedbackMessageCommandResultV2 | FeedbackIntentRecoveryResultFor<"feedback:reply">>;
  appendRevision(query: FeedbackRepositoryScope & { threadId: string; messageId: string; command: FeedbackAppendRevisionCommandV2 }, options?: FeedbackRepositoryOptions): Promise<FeedbackMessageCommandResultV2 | FeedbackIntentRecoveryResultFor<"feedback:revise">>;
  recoverIntent(query: FeedbackRepositoryScope & { threadId: string; intentId: string; requestHash: string; operation: FeedbackRecoverableOperation }, options?: FeedbackRepositoryOptions): Promise<FeedbackIntentRecoveryResultV2>;
  uploadAttachment(query: FeedbackRepositoryScope & { threadId: string; command: FeedbackUploadAttachmentCommandV2; source: FeedbackUploadStreamSource }, options?: FeedbackRepositoryOptions): Promise<FeedbackAttachmentCommandResultV2 | FeedbackIntentRecoveryResultFor<"feedback:attachment:upload">>;
  getAttachment(query: FeedbackRepositoryScope & { threadId: string; attachmentId: string }, options?: FeedbackRepositoryOptions): Promise<FeedbackDownloadStream>;
}
