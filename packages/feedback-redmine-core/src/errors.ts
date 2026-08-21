import type { RedmineProblemV1 } from "@geibee/feedback-contracts";

export type RedmineErrorCode = RedmineProblemV1["code"];

export const redmineErrorCodes = [
  "redmine.unauthenticated",
  "redmine.invalid_api_key",
  "redmine.permission_denied",
  "redmine.not_found",
  "redmine.duplicate_thread_id",
  "redmine.thread_mismatch",
  "redmine.content_type_rejected",
  "redmine.payload_too_large",
  "redmine.validation_failed",
  "redmine.rate_limited",
  "redmine.unavailable",
  "redmine.contract_invalid",
  "feedback.locator_too_large"
] as const satisfies readonly RedmineErrorCode[];

export function isRedmineErrorCode(value: unknown): value is RedmineErrorCode {
  return typeof value === "string" && (redmineErrorCodes as readonly string[]).includes(value);
}

export class RedmineFeedbackError extends Error {
  readonly code: RedmineErrorCode;
  readonly retryable: boolean;
  readonly upstreamStatus: number | null;
  readonly cause: unknown;

  constructor(
    code: RedmineErrorCode,
    message: string,
    options: { retryable?: boolean; upstreamStatus?: number | null; cause?: unknown } = {}
  ) {
    super(message);
    this.name = "RedmineFeedbackError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.upstreamStatus = options.upstreamStatus ?? null;
    this.cause = options.cause;
  }
}

export function contractError(message: string): RedmineFeedbackError {
  return new RedmineFeedbackError("redmine.contract_invalid", message);
}
