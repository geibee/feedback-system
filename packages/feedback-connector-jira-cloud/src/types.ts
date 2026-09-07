import type { FeedbackAbortSignal } from "@geibee/feedback-connector-sdk";

export const jiraCloudRecoveryPropertyKey = "com.geibee.feedback.recovery.v2" as const;
export const jiraCloudMessagePropertyKey = "com.geibee.feedback.message.v2" as const;
export const jiraCloudAttachmentPropertyPrefix = "com.geibee.feedback.attachment.v2." as const;

export type JiraCloudJsonBody = {
  kind: "json";
  value: unknown;
};

export type JiraCloudMultipartFileBody = {
  kind: "multipart-file";
  fieldName: "file";
  filename: string;
  contentType: string;
  sizeBytes: number;
  content: AsyncIterable<Uint8Array>;
};

export type JiraCloudRequest = {
  method: "GET" | "POST" | "PUT";
  path: string;
  headers?: Readonly<Record<string, string>>;
  body?: JiraCloudJsonBody | JiraCloudMultipartFileBody;
  responseMode?: "json" | "stream";
  signal?: FeedbackAbortSignal;
};

export type JiraCloudResponse = {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: unknown;
  stream?: AsyncIterable<Uint8Array>;
};

/**
 * HTTP実装とmanaged acceptance fakeが共有する最小transport境界。
 * transport自身はwriteを再試行してはならない。
 */
export interface JiraCloudTransport {
  request(request: JiraCloudRequest): Promise<JiraCloudResponse>;
}

export type JiraCloudProblemCode =
  | "feedback.invalid_request"
  | "feedback.forbidden"
  | "feedback.not_found"
  | "feedback.conflict"
  | "feedback.integrity_error"
  | "feedback.provider_unavailable"
  | "feedback.provider_timeout"
  | "feedback.rate_limited"
  | "feedback.payload_too_large"
  | "feedback.unsupported_media_type"
  | "feedback.unsupported";

/** frozen wire Problemへそのまま写像できるprovider error。 */
export class JiraCloudConnectorProblem extends Error {
  readonly status: number;
  readonly code: JiraCloudProblemCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly resultUnknown: boolean;

  constructor(input: {
    message: string;
    status: number;
    code: JiraCloudProblemCode;
    retryable: boolean;
    retryAfterSeconds?: number;
    resultUnknown?: boolean;
  }) {
    super(input.message);
    this.name = "JiraCloudConnectorProblem";
    this.status = input.status;
    this.code = input.code;
    this.retryable = input.retryable;
    this.retryAfterSeconds = input.retryAfterSeconds;
    this.resultUnknown = input.resultUnknown ?? false;
  }
}

export class JiraCloudRequestCancelledError extends Error {
  constructor() {
    super("Jira Cloud requestはcancelされました");
    this.name = "JiraCloudRequestCancelledError";
  }
}

export type JiraCloudFetchHeaders = {
  get(name: string): string | null;
  forEach?(callback: (value: string, key: string) => void): void;
};

export type JiraCloudFetchResponse = {
  status: number;
  headers: JiraCloudFetchHeaders;
  json(): Promise<unknown>;
  text(): Promise<string>;
  body: AsyncIterable<Uint8Array> | null;
};

export type JiraCloudFetch = (
  input: string,
  init: {
    method: string;
    headers: Readonly<Record<string, string>>;
    body?: string | AsyncIterable<Uint8Array>;
    signal?: unknown;
    duplex?: "half";
    redirect?: "follow" | "manual" | "error";
  }
) => Promise<JiraCloudFetchResponse>;

export type JiraCloudFetchTransportOptions = {
  baseUrl: string;
  authorization: string;
  fetch: JiraCloudFetch;
  timeoutMilliseconds: number;
  createBoundary?: () => string;
};

export type JiraCloudRecoverySeed = {
  schemaVersion: "2";
  threadId: string;
  intentId: string;
  requestHash: string;
  scope: {
    workspaceId: string;
    resource: { kind: string; key: string };
  };
  state: "recovery-seed";
};

export type JiraCloudBoundRecoveryProperty = Omit<JiraCloudRecoverySeed, "state"> & {
  state: "bound";
  envelope: unknown;
};

export type JiraCloudRawCandidateMetadata = {
  provider: "jira-cloud";
  recoveryProperty: unknown;
  commentMarkers: readonly { providerCommentId: string; marker: unknown }[];
  attachmentMarkers: readonly { propertyKey: string; marker: unknown }[];
};

export type JiraCloudConnectorConfiguration = {
  profileId: string;
  installationId: string;
  application: string;
  environment: string;
  participantId: string;
  issueTypeId: string;
  maximumAttachmentBytes: number;
  attachmentContentTypes: readonly string[];
  pageSize?: number;
  recoveryRetryAfterSeconds?: number;
};
