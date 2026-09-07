import type {
  FeedbackClientPort,
  FeedbackDownloadResult,
  FeedbackGetAttachmentQuery,
  FeedbackGetProfileQuery,
  FeedbackIssueParticipantQuery,
  FeedbackGetThreadQuery,
  FeedbackListResourcesQuery,
  FeedbackListThreadsQuery,
  FeedbackListWorkspacesQuery,
  FeedbackRecoverIntentQuery,
  FeedbackRequestOptions,
  FeedbackUploadSource
} from "./index.js";

export type FeedbackClientMethod = keyof FeedbackClientPort;

export type FeedbackClientCall = {
  method: FeedbackClientMethod;
  query: unknown;
  options: FeedbackRequestOptions | undefined;
};

export interface RecordingFeedbackClient extends FeedbackClientPort {
  readonly calls: readonly FeedbackClientCall[];
  count(method: FeedbackClientMethod): number;
}

export function createFakeFeedbackClient(handlers: Partial<FeedbackClientPort> = {}): RecordingFeedbackClient {
  const calls: FeedbackClientCall[] = [];
  const missing = (method: FeedbackClientMethod): never => {
    throw new Error(`unexpected FeedbackClientPort call: ${method}`);
  };
  const record = (method: FeedbackClientMethod, query: unknown, options: FeedbackRequestOptions | undefined) => {
    calls.push({ method, query, options });
  };
  return {
    get calls() { return calls; },
    count: (method) => calls.filter((call) => call.method === method).length,
    async issueParticipant(query: FeedbackIssueParticipantQuery, options?: FeedbackRequestOptions) {
      record("issueParticipant", query, options);
      return handlers.issueParticipant ? handlers.issueParticipant(query, options) : missing("issueParticipant");
    },
    async getProfile(query: FeedbackGetProfileQuery, options?: FeedbackRequestOptions) {
      record("getProfile", query, options);
      return handlers.getProfile ? handlers.getProfile(query, options) : missing("getProfile");
    },
    async listWorkspaces(query: FeedbackListWorkspacesQuery, options?: FeedbackRequestOptions) {
      record("listWorkspaces", query, options);
      return handlers.listWorkspaces ? handlers.listWorkspaces(query, options) : missing("listWorkspaces");
    },
    async listResources(query: FeedbackListResourcesQuery, options?: FeedbackRequestOptions) {
      record("listResources", query, options);
      return handlers.listResources ? handlers.listResources(query, options) : missing("listResources");
    },
    async listThreads(query: FeedbackListThreadsQuery, options?: FeedbackRequestOptions) {
      record("listThreads", query, options);
      return handlers.listThreads ? handlers.listThreads(query, options) : missing("listThreads");
    },
    async getThread(query: FeedbackGetThreadQuery, options?: FeedbackRequestOptions) {
      record("getThread", query, options);
      return handlers.getThread ? handlers.getThread(query, options) : missing("getThread");
    },
    async createThread(query, options) {
      record("createThread", query, options);
      return handlers.createThread ? handlers.createThread(query, options) : missing("createThread");
    },
    async reply(query, options) {
      record("reply", query, options);
      return handlers.reply ? handlers.reply(query, options) : missing("reply");
    },
    async appendRevision(query, options) {
      record("appendRevision", query, options);
      return handlers.appendRevision ? handlers.appendRevision(query, options) : missing("appendRevision");
    },
    async recoverIntent(query: FeedbackRecoverIntentQuery, options?: FeedbackRequestOptions) {
      record("recoverIntent", query, options);
      return handlers.recoverIntent ? handlers.recoverIntent(query, options) : missing("recoverIntent");
    },
    async uploadAttachment(query, options) {
      record("uploadAttachment", query, options);
      return handlers.uploadAttachment ? handlers.uploadAttachment(query, options) : missing("uploadAttachment");
    },
    async getAttachment(query: FeedbackGetAttachmentQuery, options?: FeedbackRequestOptions): Promise<FeedbackDownloadResult> {
      record("getAttachment", query, options);
      return handlers.getAttachment ? handlers.getAttachment(query, options) : missing("getAttachment");
    }
  };
}

export function createDeferredFeedbackClientResult<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

export function createTrackedUploadSource(chunks: readonly Uint8Array[]): FeedbackUploadSource & {
  readonly streamCalls: number;
  readonly yieldedChunks: number;
} {
  let streamCalls = 0;
  let yieldedChunks = 0;
  return {
    sizeBytes: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    get streamCalls() { return streamCalls; },
    get yieldedChunks() { return yieldedChunks; },
    async *stream() {
      streamCalls += 1;
      for (const chunk of chunks) {
        yieldedChunks += 1;
        yield chunk;
      }
    }
  };
}
