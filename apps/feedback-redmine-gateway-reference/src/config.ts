import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  validateBaseUrl,
  validateConnectorProfile,
  type RedmineConnectorProfile
} from "@geibee/feedback-redmine-core/trusted";
import type { GatewayServerProfile } from "@geibee/feedback-redmine-gateway";

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
  const apiKey = requiredSecretOrFile(
    environment,
    "FEEDBACK_REDMINE_GATEWAY_API_KEY",
    "FEEDBACK_REDMINE_GATEWAY_API_KEY_FILE"
  );
  const participantSigningKey = requiredSecret(environment, "FEEDBACK_PARTICIPANT_SIGNING_KEY");
  if (new TextEncoder().encode(participantSigningKey).byteLength < 32) {
    throw new Error("FEEDBACK_PARTICIPANT_SIGNING_KEYは32 bytes以上必要です");
  }
  const connector = loadConnectorProfile(environment);
  const optionalIssueFields = parseOptionalIssueFields(environment.FEEDBACK_REDMINE_OPTIONAL_ISSUE_FIELDS);
  const profiles = new Map<string, GatewayServerProfile>();
  const secrets = new Map<string, string>();
  profiles.set(connector.profileId, {
    ...connector,
    authorizationMode: "resource-scoped",
    secretRef: "FEEDBACK_REDMINE_GATEWAY_API_KEY",
    optionalIssueFields
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

function parseOptionalIssueFields(value: string | undefined): Array<"parent_issue" | "due_date" | "priority"> {
  if (!value) return [];
  const fields = value.split(",").map((field) => field.trim());
  const allowed = new Set(["parent_issue", "due_date", "priority"]);
  if (fields.some((field) => !allowed.has(field)) || new Set(fields).size !== fields.length) {
    throw new Error("FEEDBACK_REDMINE_OPTIONAL_ISSUE_FIELDSはparent_issue,due_date,priorityの重複しないsubsetで指定してください");
  }
  return fields as Array<"parent_issue" | "due_date" | "priority">;
}

function loadConnectorProfile(environment: NodeJS.ProcessEnv) {
  const path = environment.FEEDBACK_REDMINE_GATEWAY_PROFILE_FILE;
  const json = environment.FEEDBACK_REDMINE_GATEWAY_PROFILE_JSON;
  if (path && json) {
    throw new Error("FEEDBACK_REDMINE_GATEWAY_PROFILE_FILEとFEEDBACK_REDMINE_GATEWAY_PROFILE_JSONは同時に指定できません");
  }
  if (!path && !json) {
    throw new Error("FEEDBACK_REDMINE_GATEWAY_PROFILE_FILEまたはFEEDBACK_REDMINE_GATEWAY_PROFILE_JSONは必須です");
  }
  if (path && !isAbsolute(path)) {
    throw new Error("FEEDBACK_REDMINE_GATEWAY_PROFILE_FILEはabsolute pathである必要があります");
  }
  if (json && new TextEncoder().encode(json).byteLength > 65_536) {
    throw new Error("FEEDBACK_REDMINE_GATEWAY_PROFILE_JSONが長すぎます");
  }
  const document = path
    ? parseJsonFile(path, "gateway profile file")
    : parseJson(json!, "gateway profile JSON");
  const clientProfileKey = path ? "clientProfileRef" : "clientProfile";
  const value = exactObject(document, [
    "profileId", clientProfileKey, "redmineBaseUrl", "projectId", "trackerId", "isPrivate", "defaultPriorityId",
    "customFieldIds", "authorizationMode", "showRedmineLink", "secretRef", "closedStatusIds"
  ], "gateway profile");
  if (value.authorizationMode !== "resource-scoped" || value.secretRef !== "FEEDBACK_REDMINE_GATEWAY_API_KEY") {
    throw new Error("authorizationMode/secretRefが不正です");
  }
  let clientProfile: unknown;
  if (path) {
    if (typeof value.clientProfileRef !== "string" || !value.clientProfileRef) {
      throw new Error("clientProfileRefが不正です");
    }
    const clientProfilePath = isAbsolute(value.clientProfileRef)
      ? value.clientProfileRef
      : resolve(dirname(path), value.clientProfileRef);
    clientProfile = parseJsonFile(clientProfilePath, "client profile file");
  } else {
    clientProfile = value.clientProfile;
  }
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
  } as RedmineConnectorProfile;
  return validateConnectorProfile(candidate, {
    allowHttpDevelopment: environment.NODE_ENV === "development"
  });
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
    return parseJson(readFileSync(path, "utf8"), name);
  } catch {
    throw new Error(`${name}をJSONとして読み込めません`);
  }
}

function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value) as unknown;
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
