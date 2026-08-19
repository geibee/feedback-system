import { RedmineTrustedClient } from "@feedback/redmine-core/trusted";
import type { GatewayDependencies, GatewayServerProfile } from "./profile.js";
import { GatewayHttpError } from "./problem.js";

export async function loadGatewayRedmineClient(
  dependencies: GatewayDependencies,
  profile: GatewayServerProfile
): Promise<RedmineTrustedClient> {
  const secret = await dependencies.loadSecret(profile.secretRef);
  if (!secret) throw new GatewayHttpError(503, "redmine.unavailable", "Redmine credentialが設定されていません");
  return new RedmineTrustedClient({
    profile,
    apiKey: secret,
    fetch: dependencies.fetch,
    allowHttpDevelopment: dependencies.allowHttpDevelopment ?? false
  });
}
