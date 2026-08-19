import type { FeedbackHostResourceRefV1 } from "@feedback/redmine-core";
import type { FeedbackRedmineGatewayHost, GatewayHostPrincipal } from "./auth.js";
import { GatewayHttpError } from "./problem.js";

export async function requireProfileAuthorization(
  host: FeedbackRedmineGatewayHost,
  principal: GatewayHostPrincipal,
  profileId: string,
  operation: "read" | "create"
): Promise<void> {
  if (!await host.authorizeProfile({ principal, operation, profileId })) {
    throw new GatewayHttpError(403, "redmine.permission_denied", "profileを利用する権限がありません");
  }
}

export async function requireResourceAuthorization(
  host: FeedbackRedmineGatewayHost,
  principal: GatewayHostPrincipal,
  profileId: string,
  operation: "list" | "create",
  resourceRef: FeedbackHostResourceRefV1
): Promise<string> {
  const result = await host.authorizeResource({ principal, operation, profileId, resourceRef });
  if (!result || !result.resourceKey || result.resourceKey.length > 200) {
    throw new GatewayHttpError(403, "redmine.permission_denied", "resourceを利用する権限がありません");
  }
  return result.resourceKey;
}

export async function requireStoredResourceAuthorization(
  host: FeedbackRedmineGatewayHost,
  principal: GatewayHostPrincipal,
  profileId: string,
  operation: "detail" | "attachment",
  storedResourceKey: string
): Promise<void> {
  if (!await host.authorizeStoredResource({ principal, operation, profileId, storedResourceKey })) {
    throw new GatewayHttpError(404, "redmine.not_found", "threadが見つかりません");
  }
}
