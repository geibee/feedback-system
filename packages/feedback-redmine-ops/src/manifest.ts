import type { RedmineInstallationManifestV1 } from "@geibee/feedback-contracts";

export type { RedmineInstallationManifestV1 } from "@geibee/feedback-contracts";

export const redmineCustomFieldSpecs = {
  threadId: { name: "Feedback Thread ID", format: "string", filter: true },
  requestHash: { name: "Feedback Request Hash", format: "string", filter: false },
  applicationKey: { name: "Feedback Application", format: "string", filter: true },
  environmentKey: { name: "Feedback Environment", format: "string", filter: true },
  externalWorkspaceKey: { name: "Feedback Workspace", format: "string", filter: true },
  pageKey: { name: "Feedback Page", format: "string", filter: true },
  hostResourceKey: { name: "Feedback Host Resource", format: "string", filter: true },
  perspectiveCode: { name: "Feedback Perspective", format: "string", filter: true },
  locator: { name: "Feedback Locator", format: "text", filter: false },
  submittedById: { name: "Feedback Submitted By ID", format: "string", filter: false },
  submittedByName: { name: "Feedback Submitted By Name", format: "string", filter: false }
} as const;

export function validateInstallationManifest(value: unknown, options: { allowHttp?: boolean } = {}): RedmineInstallationManifestV1 {
  const item = exact(value, [
    "schemaVersion", "profileId", "displayName", "applicationKey", "environmentKey", "externalWorkspaceKey",
    "redmineBaseUrl", "project", "trackerName", "openStatusName", "closedStatusName", "defaultPriorityName",
    "roleName", "integrationUser", "isPrivate", "captureEnabled", "showRedmineLink", "perspectives"
  ], "installation manifest", ["perspectives"]);
  if (item.schemaVersion !== "1") invalid("schemaVersionは1である必要があります");
  const profileId = key(item.profileId, "profileId");
  const applicationKey = key(item.applicationKey, "applicationKey");
  const environmentKey = key(item.environmentKey, "environmentKey");
  const project = exact(item.project, ["identifier", "name"], "project");
  const integrationUser = exact(item.integrationUser, ["login", "firstName", "lastName", "mail"], "integrationUser");
  let redmineBaseUrl: URL;
  try {
    redmineBaseUrl = new URL(string(item.redmineBaseUrl, "redmineBaseUrl", 2048));
  } catch {
    invalid("redmineBaseUrlがURLではありません");
  }
  if (redmineBaseUrl!.protocol !== "https:" && !(options.allowHttp && redmineBaseUrl!.protocol === "http:")) {
    invalid("redmineBaseUrlはHTTPSである必要があります");
  }
  if (redmineBaseUrl!.username || redmineBaseUrl!.password || redmineBaseUrl!.search || redmineBaseUrl!.hash) {
    invalid("redmineBaseUrlへuserinfo/query/fragmentは指定できません");
  }
  const identifier = string(project.identifier, "project.identifier", 100);
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(identifier)) invalid("project.identifierが不正です");
  const mail = string(integrationUser.mail, "integrationUser.mail", 254);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(mail)) invalid("integrationUser.mailが不正です");
  for (const flag of ["isPrivate", "captureEnabled", "showRedmineLink"] as const) {
    if (typeof item[flag] !== "boolean") invalid(`${flag}はbooleanである必要があります`);
  }
  const perspectives = item.perspectives === undefined
    ? undefined
    : parsePerspectives(item.perspectives);
  return {
    schemaVersion: "1",
    profileId,
    displayName: string(item.displayName, "displayName", 200),
    applicationKey,
    environmentKey,
    externalWorkspaceKey: string(item.externalWorkspaceKey, "externalWorkspaceKey", 200),
    redmineBaseUrl: redmineBaseUrl!.toString().replace(/\/$/u, ""),
    project: { identifier, name: string(project.name, "project.name", 255) },
    trackerName: string(item.trackerName, "trackerName", 100),
    openStatusName: string(item.openStatusName, "openStatusName", 100),
    closedStatusName: string(item.closedStatusName, "closedStatusName", 100),
    defaultPriorityName: string(item.defaultPriorityName, "defaultPriorityName", 100),
    roleName: string(item.roleName, "roleName", 100),
    integrationUser: {
      login: string(integrationUser.login, "integrationUser.login", 255),
      firstName: string(integrationUser.firstName, "integrationUser.firstName", 30),
      lastName: string(integrationUser.lastName, "integrationUser.lastName", 255),
      mail
    },
    isPrivate: item.isPrivate as boolean,
    captureEnabled: item.captureEnabled as boolean,
    showRedmineLink: item.showRedmineLink as boolean,
    ...(perspectives === undefined ? {} : { perspectives })
  };
}

export function defaultLocalManifest(): RedmineInstallationManifestV1 {
  return {
    schemaVersion: "1",
    profileId: "feedback-local",
    displayName: "Feedback Local",
    applicationKey: "feedback-demo",
    environmentKey: "local",
    externalWorkspaceKey: "local-review",
    redmineBaseUrl: "http://feedback-redmine:3000",
    project: { identifier: "feedback-local", name: "Feedback Local" },
    trackerName: "Feedback",
    openStatusName: "New",
    closedStatusName: "Closed",
    defaultPriorityName: "Normal",
    roleName: "Feedback integration",
    integrationUser: {
      login: "feedback_integration",
      firstName: "Feedback",
      lastName: "Integration",
      mail: "feedback-integration@example.invalid"
    },
    isPrivate: true,
    captureEnabled: true,
    showRedmineLink: true
  };
}

function parsePerspectives(value: unknown): Array<{ code: string; label: string }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) invalid("perspectivesは1〜100件で指定してください");
  const perspectives = value.map((entry) => {
    const perspective = exact(entry, ["code", "label"], "perspective");
    return { code: key(perspective.code, "perspective.code"), label: string(perspective.label, "perspective.label", 200) };
  });
  if (new Set(perspectives.map((perspective) => perspective.code)).size !== perspectives.length) {
    invalid("perspective.codeが重複しています");
  }
  return perspectives;
}

function exact(value: unknown, keys: readonly string[], name: string, optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${name}がobjectではありません`);
  const item = value as Record<string, unknown>;
  const allowed = new Set(keys);
  const unknown = Object.keys(item).find((candidate) => !allowed.has(candidate));
  if (unknown) invalid(`${name}にunknown propertyがあります: ${unknown}`);
  const missing = keys.find((candidate) => !optional.includes(candidate) && !(candidate in item));
  if (missing) invalid(`${name}に必須propertyがありません: ${missing}`);
  return item;
}

function key(value: unknown, name: string): string {
  const result = string(value, name, 100);
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(result)) invalid(`${name}の形式が不正です`);
  return result;
}

function string(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) invalid(`${name}が不正です`);
  return value;
}

function invalid(message: string): never {
  throw new Error(message);
}
