import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { validateConnectorProfile } from "@feedback/redmine-core/trusted";
import type { GatewayServerProfile } from "@feedback/redmine-gateway";

export type ReferenceGatewayConfig = {
  port: number;
  profiles: Map<string, GatewayServerProfile>;
  secrets: Map<string, string>;
  sessionSecret: string;
};

export function loadReferenceGatewayConfig(environment: NodeJS.ProcessEnv = process.env): ReferenceGatewayConfig {
  const path = environment.FEEDBACK_REDMINE_GATEWAY_PROFILE_FILE;
  if (!path) throw new Error("FEEDBACK_REDMINE_GATEWAY_PROFILE_FILEは必須です");
  if (!isAbsolute(path)) throw new Error("FEEDBACK_REDMINE_GATEWAY_PROFILE_FILEはabsolute pathである必要があります");
  const apiKey = requiredSecret(environment, "FEEDBACK_REDMINE_GATEWAY_API_KEY");
  const sessionSecret = requiredSecret(environment, "FEEDBACK_REDMINE_GATEWAY_SESSION_SECRET");
  const document = parseJsonFile(path, "gateway profile file");
  const value = exactObject(document, [
    "profileId", "clientProfileRef", "redmineBaseUrl", "projectId", "trackerId", "isPrivate", "defaultPriorityId",
    "customFieldIds", "authorizationMode", "showRedmineLink", "secretRef"
  ], "gateway profile");
  if (typeof value.clientProfileRef !== "string" || !value.clientProfileRef) {
    throw new Error("clientProfileRefが不正です");
  }
  if (value.authorizationMode !== "resource-scoped" || value.secretRef !== "FEEDBACK_REDMINE_GATEWAY_API_KEY") {
    throw new Error("authorizationMode/secretRefが不正です");
  }
  const clientProfilePath = isAbsolute(value.clientProfileRef)
    ? value.clientProfileRef
    : resolve(dirname(path), value.clientProfileRef);
  const clientProfile = parseJsonFile(clientProfilePath, "client profile file");
  const candidate = {
    profileId: value.profileId,
    clientProfile,
    redmineBaseUrl: value.redmineBaseUrl,
    projectId: value.projectId,
    trackerId: value.trackerId,
    isPrivate: value.isPrivate,
    defaultPriorityId: value.defaultPriorityId,
    customFieldIds: value.customFieldIds,
    showRedmineLink: value.showRedmineLink
  } as GatewayServerProfile;
  const connector = validateConnectorProfile(candidate, {
    allowHttpDevelopment: environment.NODE_ENV === "development"
  });
  const profiles = new Map<string, GatewayServerProfile>();
  const secrets = new Map<string, string>();
  profiles.set(connector.profileId, {
    ...connector,
    authorizationMode: "resource-scoped",
    secretRef: "FEEDBACK_REDMINE_GATEWAY_API_KEY"
  });
  secrets.set("FEEDBACK_REDMINE_GATEWAY_API_KEY", apiKey);
  const port = Number(environment.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORTが不正です");
  return { port, profiles, secrets, sessionSecret };
}

function requiredSecret(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name}は必須です`);
  return value;
}

function parseJsonFile(path: string, name: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error(`${name}をJSONとして読み込めません`);
  }
}

function exactObject(value: unknown, allowedKeys: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name}がobjectではありません`);
  const item = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(item).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${name}にunknown propertyがあります: ${unknown}`);
  const missing = allowedKeys.find((key) => !(key in item));
  if (missing) throw new Error(`${name}に必須propertyがありません: ${missing}`);
  return item;
}
