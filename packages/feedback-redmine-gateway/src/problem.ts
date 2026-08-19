import { RedmineFeedbackError } from "@feedback/redmine-core";

export class GatewayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: RedmineFeedbackError["code"],
    message: string,
    readonly retryable = false,
    readonly upstreamStatus: number | null = null
  ) {
    super(message);
    this.name = "GatewayHttpError";
  }
}

export function problemResponse(error: unknown, requestId: string): Response {
  const normalized = normalize(error);
  return jsonResponse({
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      upstreamStatus: normalized.upstreamStatus,
      requestId
    }
  }, normalized.status, "application/problem+json");
}

export function jsonResponse(value: unknown, status = 200, contentType = "application/json"): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": `${contentType}; charset=utf-8`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function normalize(error: unknown): GatewayHttpError {
  if (error instanceof GatewayHttpError) return error;
  if (error instanceof RedmineFeedbackError) {
    const status = error.upstreamStatus && [401, 403, 404, 406, 409, 413, 422, 429].includes(error.upstreamStatus)
      ? error.upstreamStatus
      : statusForCode(error.code);
    return new GatewayHttpError(status, error.code, error.message, error.retryable, error.upstreamStatus);
  }
  return new GatewayHttpError(500, "redmine.unavailable", "Feedback gatewayで予期しないerrorが発生しました", false);
}

function statusForCode(code: RedmineFeedbackError["code"]): number {
  if (code === "redmine.unauthenticated") return 401;
  if (code === "redmine.invalid_api_key") return 401;
  if (code === "redmine.permission_denied") return 403;
  if (code === "redmine.not_found") return 404;
  if (code === "redmine.duplicate_thread_id" || code === "redmine.thread_mismatch") return 409;
  if (code === "redmine.content_type_rejected") return 406;
  if (code === "redmine.payload_too_large") return 413;
  if (code === "redmine.validation_failed") return 422;
  if (code === "redmine.rate_limited") return 429;
  if (code === "redmine.contract_invalid" || code === "feedback.locator_too_large") return 400;
  return 503;
}
