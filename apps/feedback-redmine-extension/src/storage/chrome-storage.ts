import type {
  ClientStatePort,
  RedmineFollowStateV1,
  RedminePendingIntentV1
} from "@feedback/redmine-core";
import { validateRedmineFollowState, validateRedminePendingIntent } from "@feedback/redmine-core";
import { isExpiredPendingIntent } from "@feedback/redmine-core";
import {
  validateExtensionProfiles,
  type ExtensionProfileV1,
  type ExtensionProfilesV1
} from "../profile.js";

export type StorageAreaLike = {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  setAccessLevel?(options: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void>;
};

export type ExtensionStorage = {
  local: StorageAreaLike;
  session: StorageAreaLike;
  managed: Pick<StorageAreaLike, "get" | "setAccessLevel">;
};

const localProfilesKey = "feedback.redmine.v1.profiles";
const managedProfilesKey = "profiles";

export async function restrictExtensionStorage(storage: ExtensionStorage): Promise<void> {
  await Promise.all([
    storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }),
    storage.session.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }),
    storage.managed.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })
  ]);
}

export class ExtensionProfileRepository {
  constructor(private readonly storage: ExtensionStorage) {}

  async list(): Promise<ExtensionProfileV1[]> {
    const [managed, local] = await Promise.all([
      this.storage.managed.get(managedProfilesKey).catch((): Record<string, unknown> => ({})),
      this.storage.local.get(localProfilesKey)
    ]);
    const managedDocument = parseManaged(managed[managedProfilesKey]);
    const localDocument = parseOptionalDocument(local[localProfilesKey]);
    const merged = new Map((localDocument?.profiles ?? []).map((profile) => [profile.id, profile]));
    for (const profile of managedDocument?.profiles ?? []) merged.set(profile.id, profile);
    return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id, "en"));
  }

  async get(profileId: string): Promise<ExtensionProfileV1 | null> {
    return (await this.list()).find((profile) => profile.id === profileId) ?? null;
  }

  async saveLocal(document: unknown): Promise<ExtensionProfilesV1> {
    const validated = validateExtensionProfiles(document);
    await this.storage.local.set({ [localProfilesKey]: validated });
    return validated;
  }

  async removeLocal(profileId: string): Promise<void> {
    const current = parseOptionalDocument((await this.storage.local.get(localProfilesKey))[localProfilesKey]) ?? {
      schemaVersion: "1" as const,
      profiles: []
    };
    await this.storage.local.set({
      [localProfilesKey]: { ...current, profiles: current.profiles.filter((profile) => profile.id !== profileId) }
    });
    await removeProfileState(this.storage, profileId);
  }
}

export class TrustedChromeClientState implements ClientStatePort {
  constructor(private readonly storage: ExtensionStorage) {}

  async getFollowState(profileId: string, principalScopeHash: string, threadId: string) {
    const value = await read<unknown>(this.storage.local, followKey(profileId, principalScopeHash, threadId));
    return value === null ? null : validateRedmineFollowState(value);
  }

  async setFollowState(state: RedmineFollowStateV1): Promise<void> {
    const validated = validateRedmineFollowState(state);
    await this.storage.local.set({ [followKey(validated.profileId, validated.principalScopeHash, validated.threadId)]: validated });
  }

  async listFollowStates(profileId: string, principalScopeHash: string): Promise<RedmineFollowStateV1[]> {
    const prefix = followPrefix(profileId, principalScopeHash);
    const all = await this.storage.local.get(null);
    return Object.entries(all).filter(([key]) => key.startsWith(prefix)).map(([, value]) => validateRedmineFollowState(value));
  }

  async getPendingIntent(profileId: string, principalScopeHash: string) {
    const key = intentKey(profileId, principalScopeHash);
    const value = await read<unknown>(this.storage.local, key);
    if (value === null) return null;
    const intent = validateRedminePendingIntent(value);
    if (isExpiredPendingIntent(intent)) {
      await this.storage.local.remove(key);
      return null;
    }
    return intent;
  }

  async setPendingIntent(profileId: string, principalScopeHash: string, intent: RedminePendingIntentV1 | null): Promise<void> {
    const validated = intent === null ? null : validateRedminePendingIntent(intent);
    if (validated && validated.profileId !== profileId) throw new Error("pending intentのprofile IDが一致しません");
    if (validated) await this.storage.local.set({ [intentKey(profileId, principalScopeHash)]: validated });
    else await this.storage.local.remove(intentKey(profileId, principalScopeHash));
  }

  async getDraft(profileId: string, principalScopeHash: string) {
    return read<string>(this.storage.session, draftKey(profileId, principalScopeHash));
  }

  async setDraft(profileId: string, principalScopeHash: string, draft: string | null): Promise<void> {
    if (draft !== null && draft.length > 20_000) throw new Error("draftが長すぎます");
    if (draft === null) await this.storage.session.remove(draftKey(profileId, principalScopeHash));
    else await this.storage.session.set({ [draftKey(profileId, principalScopeHash)]: draft });
  }

  async clearLocalState(profileId: string, principalScopeHash: string): Promise<void> {
    const all = await this.storage.local.get(null);
    const keys = Object.keys(all).filter((key) =>
      key.startsWith(followPrefix(profileId, principalScopeHash)) || key === intentKey(profileId, principalScopeHash)
    );
    if (keys.length) await this.storage.local.remove(keys);
    await this.storage.session.remove(draftKey(profileId, principalScopeHash));
  }
}

export async function removeProfileState(storage: ExtensionStorage, profileId: string): Promise<void> {
  const [local, session] = await Promise.all([storage.local.get(null), storage.session.get(null)]);
  const localPrefix = `feedback.redmine.v1:${escape(profileId)}:`;
  const sessionPrefix = `feedback.redmine.v1:${escape(profileId)}:`;
  const localKeys = Object.keys(local).filter((key) => key.startsWith(localPrefix));
  const sessionKeys = Object.keys(session).filter((key) => key.startsWith(sessionPrefix));
  if (localKeys.length) await storage.local.remove(localKeys);
  if (sessionKeys.length) await storage.session.remove(sessionKeys);
}

function parseManaged(value: unknown): ExtensionProfilesV1 | null {
  if (value === undefined) return null;
  if (typeof value === "string") {
    try { return validateExtensionProfiles(JSON.parse(value)); } catch { throw new Error("managed profile JSONが不正です"); }
  }
  return validateExtensionProfiles(value);
}

function parseOptionalDocument(value: unknown): ExtensionProfilesV1 | null {
  return value === undefined ? null : validateExtensionProfiles(value);
}

async function read<T>(area: StorageAreaLike, key: string): Promise<T | null> {
  return (await area.get(key))[key] as T | undefined ?? null;
}

const escape = (value: string) => encodeURIComponent(value);
const followPrefix = (profileId: string, principal: string) => `feedback.redmine.v1:${escape(profileId)}:${escape(principal)}:follow:`;
const followKey = (profileId: string, principal: string, threadId: string) => `${followPrefix(profileId, principal)}${escape(threadId)}`;
const intentKey = (profileId: string, principal: string) => `feedback.redmine.v1:${escape(profileId)}:${escape(principal)}:intent`;
const draftKey = (profileId: string, principal: string) => `feedback.redmine.v1:${escape(profileId)}:${escape(principal)}:draft`;
