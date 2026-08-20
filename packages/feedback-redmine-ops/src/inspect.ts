import { readFile } from "node:fs/promises";
import { redmineCustomFieldSpecs, validateInstallationManifest } from "./manifest.js";

export type InspectionCheck = { key: string; status: "ok" | "missing" | "mismatch"; detail: string };
export type InspectionReport = {
  schemaVersion: "1";
  redmineVersion: string | null;
  principal: { id: number; login: string; admin: boolean } | null;
  checks: InspectionCheck[];
  resolvedIds: {
    projectId: number | null;
    trackerId: number | null;
    roleId: number | null;
    integrationUserId: number | null;
    defaultPriorityId: number | null;
    closedStatusIds: number[];
    customFieldIds: Record<string, number>;
  };
  generated: {
    clientProfile: Record<string, unknown>;
    serverProfile: Record<string, unknown>;
    runtimeConfig: Record<string, unknown>;
  } | null;
};

export async function inspectRedmine(input: {
  manifestPath: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}): Promise<InspectionReport> {
  if (!input.apiKey) throw new Error("Redmine API keyがありません");
  const manifest = validateInstallationManifest(JSON.parse(await readFile(input.manifestPath, "utf8")));
  const fetchImplementation = input.fetch ?? globalThis.fetch;
  const request = async (path: string): Promise<Record<string, unknown> | null> => {
    const response = await fetchImplementation(`${manifest.redmineBaseUrl}${path}`, {
      headers: { Accept: "application/json", "X-Redmine-API-Key": input.apiKey },
      redirect: "error"
    });
    if (response.status === 404) return null;
    if (response.status === 401) throw new Error("Redmine API keyが無効です");
    if (response.status === 403) throw new Error(`Redmine APIの参照権限がありません: ${path}`);
    if (!response.ok) throw new Error(`Redmine APIが失敗しました: ${path} HTTP ${response.status}`);
    return await response.json() as Record<string, unknown>;
  };
  const [current, projectResult, trackersResult, statusesResult, prioritiesResult, fieldsResult, rolesResult, usersResult] = await Promise.all([
    request("/users/current.json"),
    request(`/projects/${encodeURIComponent(manifest.project.identifier)}.json?include=trackers,issue_custom_fields`),
    request("/trackers.json"),
    request("/issue_statuses.json"),
    request("/enumerations/issue_priorities.json"),
    request("/custom_fields.json"),
    request("/roles.json"),
    request(`/users.json?name=${encodeURIComponent(manifest.integrationUser.login)}&limit=100`)
  ]);
  const user = object(current?.user);
  const project = object(projectResult?.project);
  const trackers = array(trackersResult?.trackers);
  const statuses = array(statusesResult?.issue_statuses);
  const priorities = array(prioritiesResult?.issue_priorities);
  const fields = array(fieldsResult?.custom_fields);
  const roles = array(rolesResult?.roles);
  const users = array(usersResult?.users);
  const tracker = named(trackers, manifest.trackerName);
  const priority = named(priorities, manifest.defaultPriorityName);
  const openStatus = named(statuses, manifest.openStatusName);
  const closedStatus = named(statuses, manifest.closedStatusName);
  const role = named(roles, manifest.roleName);
  const integrationUser = users.find((candidate) => candidate.login === manifest.integrationUser.login) ?? null;
  const roleId = integer(role?.id);
  const projectId = integer(project?.id);
  const [roleResult, membershipsResult] = await Promise.all([
    roleId === null ? Promise.resolve(null) : request(`/roles/${roleId}.json`),
    projectId === null ? Promise.resolve(null) : request(`/projects/${encodeURIComponent(manifest.project.identifier)}/memberships.json?limit=100`)
  ]);
  const roleDetail = object(roleResult?.role);
  const memberships = array(membershipsResult?.memberships);
  const checks: InspectionCheck[] = [];
  checks.push(check("project", project, manifest.project.name));
  checks.push(check("tracker", tracker, manifest.trackerName));
  checks.push(checkStatus("open-status", openStatus, manifest.openStatusName, false));
  checks.push(checkStatus("closed-status", closedStatus, manifest.closedStatusName, true));
  checks.push(check("priority", priority, manifest.defaultPriorityName));
  checks.push(checkRole(roleDetail, manifest.roleName, manifest.isPrivate));
  checks.push(checkIntegrationUser(integrationUser, manifest.integrationUser));
  checks.push(checkMembership(memberships, integrationUser, role));
  const customFieldIds: Record<string, number> = {};
  for (const [key, spec] of Object.entries(redmineCustomFieldSpecs)) {
    const field = named(fields, spec.name);
    if (field && integer(field.id) !== null) customFieldIds[key] = integer(field.id)!;
    const format = typeof field?.field_format === "string" ? field.field_format : null;
    checks.push({
      key: `custom-field.${key}`,
      status: !field ? "missing" : format === null || format === spec.format ? "ok" : "mismatch",
      detail: !field ? `${spec.name}がありません` : format === null || format === spec.format ? `${spec.name}を検出しました` : `${spec.name}の形式が${format}です`
    });
  }
  const resolvedIds = {
    projectId,
    trackerId: integer(tracker?.id),
    roleId,
    integrationUserId: integer(integrationUser?.id),
    defaultPriorityId: integer(priority?.id),
    closedStatusIds: integer(closedStatus?.id) === null ? [] : [integer(closedStatus?.id)!],
    customFieldIds
  };
  const complete = resolvedIds.projectId !== null && resolvedIds.trackerId !== null && resolvedIds.roleId !== null &&
    resolvedIds.integrationUserId !== null &&
    Object.keys(customFieldIds).length === Object.keys(redmineCustomFieldSpecs).length && resolvedIds.closedStatusIds.length > 0 &&
    checks.every((item) => item.status === "ok");
  const clientProfile = {
    schemaVersion: "1",
    id: manifest.profileId,
    displayName: manifest.displayName,
    applicationKey: manifest.applicationKey,
    environmentKey: manifest.environmentKey,
    externalWorkspaceKey: manifest.externalWorkspaceKey,
    perspectives: [{ code: "general", label: "一般" }],
    capture: { enabled: manifest.captureEnabled, maximumUploadBytes: 10_485_760, contentTypes: ["image/png", "image/webp"] },
    attachments: { maximumInlinePreviewBytes: 10_485_760, maximumDownloadBytes: 52_428_800 },
    showRedmineLink: manifest.showRedmineLink
  };
  return {
    schemaVersion: "1",
    redmineVersion: responseVersion(current),
    principal: user && integer(user.id) !== null && typeof user.login === "string"
      ? { id: integer(user.id)!, login: user.login, admin: user.admin === true }
      : null,
    checks,
    resolvedIds,
    generated: complete ? {
      clientProfile,
      serverProfile: {
        profileId: manifest.profileId,
        clientProfileRef: "client-profile.json",
        redmineBaseUrl: manifest.redmineBaseUrl,
        projectId: resolvedIds.projectId,
        trackerId: resolvedIds.trackerId,
        isPrivate: manifest.isPrivate,
        defaultPriorityId: resolvedIds.defaultPriorityId,
        closedStatusIds: resolvedIds.closedStatusIds,
        customFieldIds,
        authorizationMode: "resource-scoped",
        showRedmineLink: manifest.showRedmineLink,
        secretRef: "FEEDBACK_REDMINE_GATEWAY_API_KEY"
      },
      runtimeConfig: {
        schemaVersion: "1",
        enabled: true,
        profileId: manifest.profileId,
        gatewayBasePath: "/internal/feedback-redmine/v1"
      }
    } : null
  };
}

function responseVersion(value: Record<string, unknown> | null): string | null {
  const version = value?._feedbackRedmineVersion;
  return typeof version === "string" ? version : null;
}

function check(key: string, value: Record<string, unknown> | null, expectedName: string): InspectionCheck {
  if (!value) return { key, status: "missing", detail: `${expectedName}がありません` };
  return { key, status: value.name === expectedName ? "ok" : "mismatch", detail: `${expectedName}を検出しました` };
}

function checkStatus(key: string, value: Record<string, unknown> | null, expectedName: string, expectedClosed: boolean): InspectionCheck {
  if (!value) return { key, status: "missing", detail: `${expectedName}がありません` };
  if (typeof value.is_closed === "boolean" && value.is_closed !== expectedClosed) {
    return { key, status: "mismatch", detail: `${expectedName}の終了属性が一致しません` };
  }
  return { key, status: "ok", detail: `${expectedName}を検出しました` };
}

function checkRole(value: Record<string, unknown> | null, expectedName: string, isPrivate: boolean): InspectionCheck {
  if (!value) return { key: "role", status: "missing", detail: `${expectedName}がありません` };
  const expected = desiredPermissions(isPrivate);
  const actual = Array.isArray(value.permissions) ? value.permissions.filter((item): item is string => typeof item === "string").sort() : [];
  const visibilityMatches = value.issues_visibility === undefined || value.issues_visibility === "all";
  if (!visibilityMatches || JSON.stringify(actual) !== JSON.stringify(expected)) {
    return { key: "role", status: "mismatch", detail: `${expectedName}の権限またはissue visibilityが最小権限構成と一致しません` };
  }
  return { key: "role", status: "ok", detail: `${expectedName}の最小権限を確認しました` };
}

function checkIntegrationUser(value: Record<string, unknown> | null, expected: {
  login: string; firstName: string; lastName: string; mail: string;
}): InspectionCheck {
  if (!value) return { key: "integration-user", status: "missing", detail: `${expected.login}がありません` };
  const matches = value.login === expected.login &&
    (value.firstname === undefined || value.firstname === expected.firstName) &&
    (value.lastname === undefined || value.lastname === expected.lastName) &&
    (value.mail === undefined || value.mail === expected.mail) &&
    (value.status === undefined || value.status === 1);
  return matches
    ? { key: "integration-user", status: "ok", detail: `${expected.login}を検出しました` }
    : { key: "integration-user", status: "mismatch", detail: `${expected.login}の属性または状態が一致しません` };
}

function checkMembership(
  memberships: Record<string, unknown>[],
  integrationUser: Record<string, unknown> | null,
  role: Record<string, unknown> | null
): InspectionCheck {
  const userId = integer(integrationUser?.id);
  const roleId = integer(role?.id);
  if (userId === null || roleId === null) {
    return { key: "membership", status: "missing", detail: "integration userまたはroleがないためmembershipを確認できません" };
  }
  const membership = memberships.find((candidate) => integer(object(candidate.user)?.id) === userId);
  if (!membership) return { key: "membership", status: "missing", detail: "integration userが対象projectのmemberではありません" };
  const actualRoleIds = array(membership.roles).map((candidate) => integer(candidate.id)).filter((id): id is number => id !== null).sort((a, b) => a - b);
  return actualRoleIds.length === 1 && actualRoleIds[0] === roleId
    ? { key: "membership", status: "ok", detail: "integration userのproject roleを確認しました" }
    : { key: "membership", status: "mismatch", detail: "integration userへ最小権限role以外が割り当てられています" };
}

function desiredPermissions(isPrivate: boolean): string[] {
  return ["view_issues", "add_issues", "edit_issues", "add_issue_notes", "view_private_notes", ...(isPrivate ? ["set_issues_private"] : [])].sort();
}

function named(values: Record<string, unknown>[], name: string): Record<string, unknown> | null {
  return values.find((value) => value.name === name) ?? null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function array(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object).filter((item): item is Record<string, unknown> => item !== null) : [];
}

function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;
}
