import type { RedmineClientProfileV1 } from "@geibee/feedback-contracts";
import { contractError } from "./errors.js";

export const redmineCustomFieldKeys = [
  "threadId",
  "requestHash",
  "applicationKey",
  "environmentKey",
  "externalWorkspaceKey",
  "pageKey",
  "hostResourceKey",
  "perspectiveCode",
  "locator",
  "submittedById",
  "submittedByName"
] as const;

export type RedmineCustomFieldKey = (typeof redmineCustomFieldKeys)[number];
export type RedmineCustomFieldIds = Record<RedmineCustomFieldKey, number>;

export type RedmineConnectorProfile = {
  profileId: string;
  clientProfile: RedmineClientProfileV1;
  redmineBaseUrl: string;
  projectId: number;
  trackerId: number;
  isPrivate: boolean;
  defaultPriorityId: number | null;
  customFieldIds: RedmineCustomFieldIds;
  showRedmineLink: boolean;
  closedStatusIds?: number[];
};

const profileIdPattern = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const allowedClientKeys = new Set([
  "schemaVersion",
  "id",
  "displayName",
  "applicationKey",
  "environmentKey",
  "externalWorkspaceKey",
  "perspectives",
  "capture",
  "attachments",
  "showRedmineLink"
]);

export function validateClientProfile(value: unknown): RedmineClientProfileV1 {
  const profile = object(value, "client profile");
  rejectUnknown(profile, allowedClientKeys, "client profile");
  if (profile.schemaVersion !== "1") throw contractError("client profile schemaVersionは1である必要があります");
  stringValue(profile.id, "profile ID", 1, 100);
  if (!profileIdPattern.test(profile.id as string)) throw contractError("profile IDの形式が不正です");
  stringValue(profile.displayName, "displayName", 1, 200);
  stringValue(profile.applicationKey, "applicationKey", 1, 100);
  stringValue(profile.environmentKey, "environmentKey", 1, 100);
  stringValue(profile.externalWorkspaceKey, "externalWorkspaceKey", 1, 200);

  if (!Array.isArray(profile.perspectives) || profile.perspectives.length > 100) {
    throw contractError("perspectivesは100件以下の配列である必要があります");
  }
  const perspectiveCodes = new Set<string>();
  for (const item of profile.perspectives) {
    const perspective = object(item, "perspective");
    rejectUnknown(perspective, new Set(["code", "label"]), "perspective");
    stringValue(perspective.code, "perspective code", 1, 100);
    stringValue(perspective.label, "perspective label", 1, 200);
    const code = perspective.code as string;
    if (!profileIdPattern.test(code)) throw contractError("perspective codeの形式が不正です");
    if (perspectiveCodes.has(code)) throw contractError("perspective codeが重複しています");
    perspectiveCodes.add(code);
  }

  const capture = object(profile.capture, "capture");
  rejectUnknown(capture, new Set(["enabled", "maximumUploadBytes", "contentTypes"]), "capture");
  if (typeof capture.enabled !== "boolean") throw contractError("capture.enabledはbooleanである必要があります");
  integerRange(capture.maximumUploadBytes, "maximumUploadBytes", 1_048_576, 10_485_760);
  if (
    !Array.isArray(capture.contentTypes) ||
    capture.contentTypes.length === 0 ||
    new Set(capture.contentTypes).size !== capture.contentTypes.length ||
    capture.contentTypes.some((type) => type !== "image/png" && type !== "image/webp")
  ) {
    throw contractError("capture.contentTypesはPNG/WebPの重複しない配列である必要があります");
  }

  const attachments = object(profile.attachments, "attachments");
  rejectUnknown(
    attachments,
    new Set(["maximumInlinePreviewBytes", "maximumDownloadBytes"]),
    "attachments"
  );
  integerRange(attachments.maximumInlinePreviewBytes, "maximumInlinePreviewBytes", 1_048_576, 10_485_760);
  integerRange(attachments.maximumDownloadBytes, "maximumDownloadBytes", 1_048_576, 52_428_800);
  if ((attachments.maximumDownloadBytes as number) < (attachments.maximumInlinePreviewBytes as number)) {
    throw contractError("maximumDownloadBytesはmaximumInlinePreviewBytes以上である必要があります");
  }
  if (profile.showRedmineLink !== undefined && typeof profile.showRedmineLink !== "boolean") {
    throw contractError("showRedmineLinkはbooleanである必要があります");
  }
  return profile as RedmineClientProfileV1;
}

export function validateConnectorProfile(
  value: RedmineConnectorProfile,
  options: { allowHttpDevelopment?: boolean } = {}
): RedmineConnectorProfile {
  const clientProfile = validateClientProfile(value.clientProfile);
  if (value.profileId !== clientProfile.id) throw contractError("server/client profile IDが一致しません");
  validateBaseUrl(value.redmineBaseUrl, options.allowHttpDevelopment ?? false);
  integerRange(value.projectId, "projectId", 1, Number.MAX_SAFE_INTEGER);
  integerRange(value.trackerId, "trackerId", 1, Number.MAX_SAFE_INTEGER);
  if (value.defaultPriorityId !== null) {
    integerRange(value.defaultPriorityId, "defaultPriorityId", 1, Number.MAX_SAFE_INTEGER);
  }
  if (typeof value.isPrivate !== "boolean" || typeof value.showRedmineLink !== "boolean") {
    throw contractError("isPrivate/showRedmineLinkはbooleanである必要があります");
  }
  if (value.closedStatusIds !== undefined && (
    !Array.isArray(value.closedStatusIds) || value.closedStatusIds.some((id) => !Number.isInteger(id) || id < 1) ||
    new Set(value.closedStatusIds).size !== value.closedStatusIds.length
  )) throw contractError("closedStatusIdsが不正です");
  const ids = redmineCustomFieldKeys.map((key) => {
    const id = value.customFieldIds[key];
    integerRange(id, `customFieldIds.${key}`, 1, Number.MAX_SAFE_INTEGER);
    return id;
  });
  if (new Set(ids).size !== ids.length) throw contractError("custom field IDがprofile内で重複しています");
  return { ...value, clientProfile };
}

export function validateBaseUrl(input: string, allowHttpDevelopment = false): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw contractError("Redmine base URLが不正です");
  }
  if (parsed.protocol !== "https:" && !(allowHttpDevelopment && parsed.protocol === "http:")) {
    throw contractError("Redmine base URLはHTTPSである必要があります");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw contractError("Redmine base URLにuserinfo/query/fragmentは指定できません");
  }
  if (input.includes("\\")) throw contractError("Redmine base URLにbackslashは指定できません");
  const rawPath = input.slice(input.indexOf(parsed.host) + parsed.host.length).split(/[?#]/, 1)[0] ?? "";
  for (const segment of rawPath.split("/")) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw contractError("Redmine base URL pathのpercent encodingが不正です");
    }
    if (decoded === "." || decoded === "..") throw contractError("Redmine base URLにdot segmentは指定できません");
  }
  return parsed;
}

export function validateHostOrigin(input: string): string {
  const parsed = validateBaseUrl(input);
  if (parsed.pathname !== "/") throw contractError("host originへpathは指定できません");
  return parsed.origin;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw contractError(`${name}はobjectである必要があります`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: Set<string>, name: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw contractError(`${name}にunknown propertyがあります: ${unknown}`);
}

function stringValue(value: unknown, name: string, minimum: number, maximum: number): void {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw contractError(`${name}の長さが不正です`);
  }
}

function integerRange(value: unknown, name: string, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw contractError(`${name}は${minimum}〜${maximum}のintegerである必要があります`);
  }
}
