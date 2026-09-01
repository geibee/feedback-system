import type {
  FeedbackAppendRevisionCommandV2,
  FeedbackAttachmentCommandResultV2,
  FeedbackCreateThreadCommandV2,
  FeedbackParticipantCredentialResultV2,
  FeedbackIntentRecoveryResultV2,
  FeedbackMessageCommandResultV2,
  FeedbackOperationV2,
  FeedbackProblemV2,
  FeedbackProfileV2,
  FeedbackReplyCommandV2,
  FeedbackResourcePageV2,
  FeedbackResourceRefV2,
  FeedbackThreadCommandResultV2,
  FeedbackThreadPageV2,
  FeedbackThreadV2,
  FeedbackUploadAttachmentCommandV2,
  FeedbackWorkspacePageV2
} from "@geibee/feedback-contracts/v2";

export interface FeedbackAbortSignal {
  readonly aborted: boolean;
  subscribe(listener: () => void): () => void;
}

export type FeedbackRequestOptions = {
  signal?: FeedbackAbortSignal;
};

export type FeedbackScopedQuery = {
  profileId: string;
  workspaceId: string;
  resource: FeedbackResourceRefV2;
};

export type FeedbackGetProfileQuery = {
  profileId: string;
  workspaceId: string;
  resource: FeedbackResourceRefV2;
};

export type FeedbackIssueParticipantQuery = {
  profileId: string;
  browserProfileId: string;
};

export type FeedbackListWorkspacesQuery = {
  profileId: string;
  cursor?: string;
};

export type FeedbackListResourcesQuery = {
  profileId: string;
  workspaceId: string;
  query?: string;
  cursor?: string;
};

export type FeedbackListThreadsQuery = FeedbackScopedQuery & {
  order?: "updated_desc" | "updated_asc";
  cursor?: string;
};

export type FeedbackRecoverIntentQuery = FeedbackScopedQuery & {
  threadId: string;
  intentId: string;
  requestHash: string;
  operation: Extract<FeedbackOperationV2, "feedback:create" | "feedback:reply" | "feedback:revise" | "feedback:attachment:upload">;
};

export type FeedbackRecoverableOperation = FeedbackRecoverIntentQuery["operation"];
export type FeedbackIntentRecoveryResultFor<TOperation extends FeedbackRecoverableOperation> =
  FeedbackIntentRecoveryResultV2 & { operation: TOperation };

export type FeedbackGetThreadQuery = FeedbackScopedQuery & {
  threadId: string;
};

export type FeedbackGetAttachmentQuery = FeedbackGetThreadQuery & {
  attachmentId: string;
};

export interface FeedbackUploadSource {
  readonly sizeBytes: number;
  stream(): AsyncIterable<Uint8Array>;
}

export interface FeedbackDownloadResult {
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly body: AsyncIterable<Uint8Array>;
}

export class FeedbackClientProblem extends Error {
  readonly problem: FeedbackProblemV2;

  constructor(problem: FeedbackProblemV2) {
    super(problem.title);
    this.name = "FeedbackClientProblem";
    this.problem = problem;
  }
}

export interface FeedbackClientPort {
  issueParticipant(query: FeedbackIssueParticipantQuery, options?: FeedbackRequestOptions): Promise<FeedbackParticipantCredentialResultV2>;
  getProfile(query: FeedbackGetProfileQuery, options?: FeedbackRequestOptions): Promise<FeedbackProfileV2>;
  listWorkspaces(query: FeedbackListWorkspacesQuery, options?: FeedbackRequestOptions): Promise<FeedbackWorkspacePageV2>;
  listResources(query: FeedbackListResourcesQuery, options?: FeedbackRequestOptions): Promise<FeedbackResourcePageV2>;
  listThreads(query: FeedbackListThreadsQuery, options?: FeedbackRequestOptions): Promise<FeedbackThreadPageV2>;
  getThread(query: FeedbackGetThreadQuery, options?: FeedbackRequestOptions): Promise<FeedbackThreadV2>;
  createThread(query: { profileId: string; workspaceId: string; command: FeedbackCreateThreadCommandV2 }, options?: FeedbackRequestOptions): Promise<FeedbackThreadCommandResultV2 | FeedbackIntentRecoveryResultFor<"feedback:create">>;
  reply(query: FeedbackScopedQuery & { threadId: string; command: FeedbackReplyCommandV2 }, options?: FeedbackRequestOptions): Promise<FeedbackMessageCommandResultV2 | FeedbackIntentRecoveryResultFor<"feedback:reply">>;
  appendRevision(query: FeedbackScopedQuery & { threadId: string; messageId: string; command: FeedbackAppendRevisionCommandV2 }, options?: FeedbackRequestOptions): Promise<FeedbackMessageCommandResultV2 | FeedbackIntentRecoveryResultFor<"feedback:revise">>;
  recoverIntent(query: FeedbackRecoverIntentQuery, options?: FeedbackRequestOptions): Promise<FeedbackIntentRecoveryResultV2>;
  uploadAttachment(query: FeedbackScopedQuery & { threadId: string; command: FeedbackUploadAttachmentCommandV2; source: FeedbackUploadSource }, options?: FeedbackRequestOptions): Promise<FeedbackAttachmentCommandResultV2 | FeedbackIntentRecoveryResultFor<"feedback:attachment:upload">>;
  getAttachment(query: FeedbackGetAttachmentQuery, options?: FeedbackRequestOptions): Promise<FeedbackDownloadResult>;
}

export {
  createFeedbackHttpClient,
  createFetchFeedbackTransport,
  type FeedbackFetch,
  type FeedbackFetchResponse,
  type FeedbackHttpClientOptions,
  type FeedbackHttpRequest,
  type FeedbackHttpRequestBody,
  type FeedbackHttpResponse,
  type FeedbackHttpTransport,
  type FeedbackRequestCredentialProvider,
  type FeedbackRequestCredentials,
  type FeedbackRequestCredentialScope
} from "./http.js";
