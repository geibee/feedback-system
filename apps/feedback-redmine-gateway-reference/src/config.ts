import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { validateBaseUrl, validateConnectorProfile } from "@feedback/redmine-core/trusted";
import type { GatewayServerProfile } from "@feedback/redmine-gateway";

export type ReferenceGatewayConfig = {
  port: number;
  publicOrigin: string;
  allowHttpDevelopment: boolean;
  profiles: Map<string, GatewayServerProfile>;
  secrets: Map<string, string>;
  participantSigningKey: string;
};

export function loadReferenceGatewayConfig(environment: NodeJS.ProcessEnv = process.env): ReferenceGatewayConfig {
  const publicOrigin = parsePublicOrigin(environment);
  const path = environment.FEEDBACK_REDMINE_GATEWAY_PROFILE_FILE;
  if (!path) throw new Error("FEEDBACK_REDMINE_GATEWAY_PROFILE_FILEは必須です");
  if (!isAbsolute(path)) throw new Error("FEEDBACK_REDMINE_GATEWAY_PROFILE_FILEはabsolute pathである必要があります");
  const apiKey = requiredSecretOrFile(
    environment,
    "FEEDBACK_REDMINE_GATEWAY_API_KEY",
    "FEEDBACK_REDMINE_GATEWAY_API_KEY_FILE"
  );
  const participantSigningKey = requiredSecret(environment, "FEEDBACK_PARTICIPANT_SIGNING_KEY");
  if (new TextEncoder().encode(participantSigningKey).byteLength < 32) {
    throw new Error("FEEDBACK_PARTICIPANT_SIGNING_KEYは32 bytes以上必要です");
  }
  const document = parseJsonFile(path, "gateway profile file");
  const value = exactObject(document, [
    "profileId", "clientProfileRef", "redmineBaseUrl", "projectId", "trackerId", "isPrivate", "defaultPriorityId",
    "customFieldIds", "authorizationMode", "showRedmineLink", "secretRef", "closedStatusIds"
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
    showRedmineLink: value.showRedmineLink,
    closedStatusIds: value.closedStatusIds
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
  return {
    port,
    publicOrigin,
    allowHttpDevelopment: environment.NODE_ENV === "development",
    profiles,
    secrets,
    participantSigningKey
  };
}

function parsePublicOrigin(environment: NodeJS.ProcessEnv): string {
  const input = environment.FEEDBACK_PUBLIC_ORIGIN;
  if (!input) throw new Error("FEEDBACK_PUBLIC_ORIGINは必須です");
  const parsed = validateBaseUrl(input, environment.NODE_ENV === "development");
  if (parsed.pathname !== "/") throw new Error("FEEDBACK_PUBLIC_ORIGINへpathは指定できません");
  return parsed.origin;
}

function requiredSecret(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name}は必須です`);
  return value;
}

function requiredSecretOrFile(environment: NodeJS.ProcessEnv, name: string, fileName: string): string {
  const direct = environment[name];
  const path = environment[fileName];
  if (direct && path) throw new Error(`${name}と${fileName}は同時に指定できません`);
  if (direct) return direct;
  if (!path) throw new Error(`${name}または${fileName}は必須です`);
  if (!isAbsolute(path)) throw new Error(`${fileName}はabsolute pathである必要があります`);
  let value: string;
  try {
    value = readFileSync(path, "utf8").replace(/\r?\n$/u, "");
  } catch {
    throw new Error(`${fileName}を読み込めません`);
  }
  if (!value || value.includes("\0")) throw new Error(`${fileName}のsecretが不正です`);
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
