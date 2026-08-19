import type { FeedbackRedmineGatewayHost, GatewayHostPrincipal } from "./auth.js";
import { GatewayHttpError } from "./problem.js";

export function validateSameOriginRequest(request: Request): void {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("Origin");
  if ((origin !== null && origin !== requestUrl.origin) || (request.method !== "GET" && origin !== requestUrl.origin)) {
    throw new GatewayHttpError(403, "redmine.permission_denied", "同一origin requestではありません");
  }
  if (request.headers.get("Sec-Fetch-Site") !== "same-origin") {
    throw new GatewayHttpError(403, "redmine.permission_denied", "Fetch Metadataがsame-originではありません");
  }
}

export async function validateCsrf(
  request: Request,
  principal: GatewayHostPrincipal,
  host: FeedbackRedmineGatewayHost
): Promise<void> {
  const token = request.headers.get("X-Feedback-CSRF") ?? "";
  if (!token || !await host.verifyCsrf({ request, principal, token })) {
    throw new GatewayHttpError(403, "redmine.permission_denied", "CSRF tokenが不正です");
  }
}
