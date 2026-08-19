import {
  validateClientProfile,
  validateHostOrigin,
  type RedmineClientProfileV1
} from "@feedback/redmine-core";
import {
  validateConnectorProfile,
  type RedmineConnectorProfile,
  type RedmineCustomFieldIds
} from "@feedback/redmine-core/trusted";

export type ExtensionProfileV1 = Omit<RedmineClientProfileV1, "schemaVersion"> & {
  hostOrigins: string[];
  redmineBaseUrl: string;
  projectId: number;
  trackerId: number;
  isPrivate: boolean;
  defaultPriorityId: number | null;
  customFieldIds: RedmineCustomFieldIds;
};

export type ExtensionProfilesV1 = {
  schemaVersion: "1";
  profiles: ExtensionProfileV1[];
};

const profileKeys = [
  "id", "displayName", "applicationKey", "environmentKey", "externalWorkspaceKey", "hostOrigins", "redmineBaseUrl",
  "projectId", "trackerId", "isPrivate", "defaultPriorityId", "customFieldIds", "perspectives", "capture", "attachments",
  "showRedmineLink"
] as const;

export function validateExtensionProfiles(value: unknown): ExtensionProfilesV1 {
  const document = exact(value, ["schemaVersion", "profiles"], "extension profile document");
  if (document.schemaVersion !== "1" || !Array.isArray(document.profiles) || document.profiles.length > 100) {
    throw new Error("extension profile documentが不正です");
  }
  const profiles = document.profiles.map((item) => validateExtensionProfile(item));
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) throw new Error("profile IDが重複しています");
  return { schemaVersion: "1", profiles };
}

export function validateExtensionProfile(value: unknown): ExtensionProfileV1 {
  const profile = exact(value, profileKeys, "extension profile", ["defaultPriorityId", "showRedmineLink"]);
  if (!Array.isArray(profile.hostOrigins) || profile.hostOrigins.length < 1 || profile.hostOrigins.length > 100 ||
    new Set(profile.hostOrigins).size !== profile.hostOrigins.length) throw new Error("hostOriginsが不正です");
  const hostOrigins = profile.hostOrigins.map((origin) => {
    if (typeof origin !== "string") throw new Error("host originがstringではありません");
    return validateHostOrigin(origin);
  });
  const clientProfile = validateClientProfile({
    schemaVersion: "1",
    id: profile.id,
    displayName: profile.displayName,
    applicationKey: profile.applicationKey,
    environmentKey: profile.environmentKey,
    externalWorkspaceKey: profile.externalWorkspaceKey,
    perspectives: profile.perspectives,
    capture: profile.capture,
    attachments: profile.attachments,
    ...(profile.showRedmineLink === undefined ? {} : { showRedmineLink: profile.showRedmineLink })
  });
  const connector = validateConnectorProfile({
    profileId: clientProfile.id,
    clientProfile,
    redmineBaseUrl: profile.redmineBaseUrl as string,
    projectId: profile.projectId as number,
    trackerId: profile.trackerId as number,
    isPrivate: profile.isPrivate as boolean,
    defaultPriorityId: profile.defaultPriorityId === undefined ? null : profile.defaultPriorityId as number | null,
    customFieldIds: profile.customFieldIds as RedmineCustomFieldIds,
    showRedmineLink: profile.showRedmineLink === true
  });
  const { schemaVersion: _schemaVersion, ...clientValues } = clientProfile;
  return {
    ...clientValues,
    hostOrigins,
    redmineBaseUrl: connector.redmineBaseUrl,
    projectId: connector.projectId,
    trackerId: connector.trackerId,
    isPrivate: connector.isPrivate,
    defaultPriorityId: connector.defaultPriorityId,
    customFieldIds: connector.customFieldIds
  };
}

export function toConnectorProfile(profile: ExtensionProfileV1, allowHttpDevelopment = false): RedmineConnectorProfile {
  const { hostOrigins: _hostOrigins, ...withoutOrigins } = profile;
  const clientProfile = validateClientProfile({
    schemaVersion: "1",
    id: profile.id,
    displayName: profile.displayName,
    applicationKey: profile.applicationKey,
    environmentKey: profile.environmentKey,
    externalWorkspaceKey: profile.externalWorkspaceKey,
    perspectives: profile.perspectives,
    capture: profile.capture,
    attachments: profile.attachments,
    ...(profile.showRedmineLink === undefined ? {} : { showRedmineLink: profile.showRedmineLink })
  });
  return validateConnectorProfile({
    profileId: profile.id,
    clientProfile,
    redmineBaseUrl: withoutOrigins.redmineBaseUrl,
    projectId: withoutOrigins.projectId,
    trackerId: withoutOrigins.trackerId,
    isPrivate: withoutOrigins.isPrivate,
    defaultPriorityId: withoutOrigins.defaultPriorityId,
    customFieldIds: withoutOrigins.customFieldIds,
    showRedmineLink: withoutOrigins.showRedmineLink === true
  }, { allowHttpDevelopment });
}

function exact(
  value: unknown,
  keys: readonly string[],
  name: string,
  optional: readonly string[] = []
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name}がobjectではありません`);
  const item = value as Record<string, unknown>;
  const allowed = new Set(keys);
  const unknown = Object.keys(item).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${name}にunknown propertyがあります: ${unknown}`);
  const missing = keys.find((key) => !optional.includes(key) && !(key in item));
  if (missing) throw new Error(`${name}に必須propertyがありません: ${missing}`);
  return item;
}
