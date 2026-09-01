import { readFile } from "node:fs/promises";
import type { FeedbackProviderProfileV2 } from "@geibee/feedback-contracts/v2/server";

type CatalogBase = {
  id: string;
  application: string;
  environment: string;
  maximumAttachmentBytes: number;
  attachmentContentTypes: readonly string[];
};

export type JiraCloudRuntimeProfile = CatalogBase & {
  connectorKey: "jira-cloud";
  siteUrl: string;
  issueTypeId: string;
  timeoutMilliseconds: number;
  pageSize: number;
  recoveryRetryAfterSeconds: number;
};

export type RedmineRuntimeProfile = CatalogBase & {
  connectorKey: "redmine";
  baseUrl: string;
  applicationKey: string;
  environmentKey: string;
  workspaceId: string;
  workspaceDisplayName: string;
  projectId: number;
  trackerId: number;
  isPrivate: boolean;
  defaultPriorityId?: number;
  customFieldIds: {
    threadId: number;
    intentId: number;
    requestHash: number;
    envelope: number;
    projection: number;
    applicationKey: number;
    environmentKey: number;
    externalWorkspaceKey: number;
    hostResourceKey: number;
  };
};

export type FeedbackConnectorRuntimeProfile = JiraCloudRuntimeProfile | RedmineRuntimeProfile;

export type FeedbackConnectorCatalog = {
  schemaVersion: "1";
  profiles: ReadonlyMap<string, FeedbackConnectorRuntimeProfile>;
};

const stableKey = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export async function loadFeedbackConnectorCatalog(absolutePath: string): Promise<FeedbackConnectorCatalog> {
  if (!absolutePath.startsWith("/") || absolutePath.includes("\0")) {
    throw new Error("Connector catalog fileはabsolute pathで指定してください");
  }
  const source = await readFile(absolutePath, "utf8");
  if (source.length > 1_048_576) throw new Error("Connector catalogが上限を超えています");
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error("Connector catalog JSONが不正です"); }
  const root = object(value, ["schemaVersion", "profiles"], "Connector catalog");
  if (root.schemaVersion !== "1") throw new Error("Connector catalog schemaVersionが不正です");
  if (!Array.isArray(root.profiles) || root.profiles.length === 0 || root.profiles.length > 100) {
    throw new Error("Connector catalog profilesが不正です");
  }
  const profiles = new Map<string, FeedbackConnectorRuntimeProfile>();
  for (const entry of root.profiles) {
    const parsed = parseRuntimeProfile(entry);
    const profile = Object.freeze({
      ...parsed,
      attachmentContentTypes: Object.freeze([...parsed.attachmentContentTypes]),
      ...(parsed.connectorKey === "redmine" ? { customFieldIds: Object.freeze({ ...parsed.customFieldIds }) } : {})
    }) as FeedbackConnectorRuntimeProfile;
    if (profiles.has(profile.id)) throw new Error(`Connector catalog profile IDが重複しています: ${profile.id}`);
    profiles.set(profile.id, profile);
  }
  return Object.freeze({ schemaVersion: "1", profiles: readonlyMap(profiles) });
}

export function validateConnectorCatalogBindings(
  catalog: FeedbackConnectorCatalog,
  profiles: readonly FeedbackProviderProfileV2[]
): void {
  for (const profile of profiles) {
    if (!profile.connectorProfileRef) throw new Error(`connectorProfileRefがありません: ${profile.profileId}`);
    const runtime = catalog.profiles.get(profile.connectorProfileRef);
    if (!runtime) throw new Error(`Connector catalog profileがありません: ${profile.connectorProfileRef}`);
    if (runtime.connectorKey !== profile.connectorKey) {
      throw new Error(`Connector keyが一致しません: ${profile.profileId}`);
    }
    if (runtime.connectorKey === "redmine" &&
        (!profile.workspacePolicy.workspaceIds.includes(runtime.workspaceId) || profile.workspacePolicy.workspaceIds.length !== 1)) {
      throw new Error(`Redmine workspace bindingが一致しません: ${profile.profileId}`);
    }
  }
}

function parseRuntimeProfile(value: unknown): FeedbackConnectorRuntimeProfile {
  const baseKeys = ["id", "connectorKey", "application", "environment", "maximumAttachmentBytes", "attachmentContentTypes"];
  const preliminary = record(value, "Connector profile");
  key(preliminary.id, "Connector profile ID");
  key(preliminary.application, "application");
  key(preliminary.environment, "environment");
  positiveInteger(preliminary.maximumAttachmentBytes, "maximumAttachmentBytes");
  const attachmentContentTypes = strings(preliminary.attachmentContentTypes, "attachmentContentTypes", 1, 100);
  for (const contentType of attachmentContentTypes) {
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(contentType)) throw new Error("attachment content typeが不正です");
  }
  if (preliminary.connectorKey === "jira-cloud") {
    const input = object(value, [...baseKeys, "siteUrl", "issueTypeId", "timeoutMilliseconds", "pageSize", "recoveryRetryAfterSeconds"], "Jira Cloud Connector profile");
    httpsUrl(input.siteUrl, "Jira Cloud siteUrl");
    bounded(input.issueTypeId, "issueTypeId", 1, 100);
    integerRange(input.timeoutMilliseconds, "timeoutMilliseconds", 100, 60_000);
    integerRange(input.pageSize, "pageSize", 1, 100);
    integerRange(input.recoveryRetryAfterSeconds, "recoveryRetryAfterSeconds", 1, 300);
    return { ...input, connectorKey: "jira-cloud", attachmentContentTypes } as unknown as JiraCloudRuntimeProfile;
  }
  if (preliminary.connectorKey === "redmine") {
    const input = object(value, [...baseKeys, "baseUrl", "applicationKey", "environmentKey", "workspaceId", "workspaceDisplayName", "projectId", "trackerId", "isPrivate", "defaultPriorityId", "customFieldIds"], "Redmine Connector profile", true);
    httpsUrl(input.baseUrl, "Redmine baseUrl");
    key(input.applicationKey, "applicationKey");
    key(input.environmentKey, "environmentKey");
    key(input.workspaceId, "workspaceId");
    bounded(input.workspaceDisplayName, "workspaceDisplayName", 1, 200);
    positiveInteger(input.projectId, "projectId");
    positiveInteger(input.trackerId, "trackerId");
    if (typeof input.isPrivate !== "boolean") throw new Error("isPrivateが不正です");
    if (input.defaultPriorityId !== undefined) positiveInteger(input.defaultPriorityId, "defaultPriorityId");
    const fields = object(input.customFieldIds, ["threadId", "intentId", "requestHash", "envelope", "projection", "applicationKey", "environmentKey", "externalWorkspaceKey", "hostResourceKey"], "customFieldIds");
    Object.entries(fields).forEach(([name, id]) => positiveInteger(id, `customFieldIds.${name}`));
    if (new Set(Object.values(fields)).size !== Object.keys(fields).length) throw new Error("customFieldIdsが重複しています");
    return { ...input, connectorKey: "redmine", attachmentContentTypes, customFieldIds: fields } as unknown as RedmineRuntimeProfile;
  }
  throw new Error("Connector keyが未対応です");
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name}がobjectではありません`);
  return value as Record<string, unknown>;
}

function object(value: unknown, keys: readonly string[], name: string, optional = false): Record<string, unknown> {
  const result = record(value, name);
  const allowed = new Set(keys);
  if (Object.keys(result).some((candidate) => !allowed.has(candidate))) throw new Error(`${name}にunknown fieldがあります`);
  if (!optional && keys.some((candidate) => !(candidate in result))) throw new Error(`${name}の必須fieldがありません`);
  const required = optional ? keys.filter((candidate) => candidate !== "defaultPriorityId") : keys;
  if (required.some((candidate) => !(candidate in result))) throw new Error(`${name}の必須fieldがありません`);
  return result;
}

function key(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !stableKey.test(value)) throw new Error(`${name}が不正です`);
}

function bounded(value: unknown, name: string, minimum: number, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) throw new Error(`${name}が不正です`);
}

function strings(value: unknown, name: string, minimum: number, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${name}が不正です`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${name}が重複しています`);
  return value as string[];
}

function positiveInteger(value: unknown, name: string): asserts value is number {
  integerRange(value, name, 1, Number.MAX_SAFE_INTEGER);
}

function integerRange(value: unknown, name: string, minimum: number, maximum: number): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${name}が不正です`);
}

function httpsUrl(value: unknown, name: string): asserts value is string {
  bounded(value, name, 1, 500);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name}が不正です`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name}はcredentialなしのHTTPS URLで指定してください`);
  }
}

function readonlyMap<K, V>(source: Map<K, V>): ReadonlyMap<K, V> {
  return Object.freeze({
    get size() { return source.size; },
    get(key: K) { return source.get(key); },
    has(key: K) { return source.has(key); },
    entries() { return source.entries(); },
    keys() { return source.keys(); },
    values() { return source.values(); },
    forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) {
      source.forEach((value, key) => callback.call(thisArg, value, key, this));
    },
    [Symbol.iterator]() { return source[Symbol.iterator](); }
  });
}
