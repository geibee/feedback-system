import type { FeedbackAbortSignal } from "@geibee/feedback-connector-sdk";

export const backlogMarkerNames = Object.freeze({
  envelope: "feedback-envelope:v2",
  recovery: "feedback-recovery-seed:v2",
  message: "feedback-message-marker:v2"
});

export type BacklogFormBody = {
  kind: "form";
  values: Readonly<Record<string, string | readonly string[]>>;
};

export type BacklogRequest = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: BacklogFormBody;
  signal?: FeedbackAbortSignal;
};

export type BacklogResponse = {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: unknown;
};

/** HTTP実装とfixtureが共有し、write retryを持たないtransport境界。 */
export interface BacklogTransport {
  request(request: BacklogRequest): Promise<BacklogResponse>;
}

export class BacklogConnectorProblem extends Error {
  readonly status: number;
  readonly code: "feedback.invalid_request" | "feedback.forbidden" | "feedback.not_found" |
    "feedback.conflict" | "feedback.integrity_error" | "feedback.provider_unavailable" |
    "feedback.provider_timeout" | "feedback.rate_limited" | "feedback.unsupported";
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly resultUnknown: boolean;

  constructor(input: {
    message: string;
    status: number;
    code: BacklogConnectorProblem["code"];
    retryable: boolean;
    retryAfterSeconds?: number;
    resultUnknown?: boolean;
  }) {
    super(input.message);
    this.name = "BacklogConnectorProblem";
    this.status = input.status;
    this.code = input.code;
    this.retryable = input.retryable;
    this.retryAfterSeconds = input.retryAfterSeconds;
    this.resultUnknown = input.resultUnknown ?? false;
  }
}

export class BacklogRequestCancelledError extends Error {
  constructor() {
    super("Backlog requestはcancelされました");
    this.name = "BacklogRequestCancelledError";
  }
}

export type BacklogFetchResponse = {
  status: number;
  headers: { get(name: string): string | null; forEach?(callback: (value: string, key: string) => void): void };
  text(): Promise<string>;
};

export type BacklogFetch = (
  input: string,
  init: {
    method: string;
    headers: Readonly<Record<string, string>>;
    body?: string;
    signal?: unknown;
    redirect?: "error";
  }
) => Promise<BacklogFetchResponse>;

export type BacklogConnectorConfiguration = {
  profileId: string;
  installationId: string;
  application: string;
  environment: string;
  participantId: string;
  workspaceId: string;
  workspaceDisplayName: string;
  projectId: number;
  issueTypeId: number;
  priorityId: number;
  customFieldIds: {
    threadId: number;
    intentId: number;
    requestHash: number;
    resourceKey: number;
  };
  pageSize?: number;
  recoveryRetryAfterSeconds?: number;
  maximumMetadataBytes: number;
};
