import {
  createMemoryClientState,
  isExpiredPendingIntent,
  validateRedmineFollowState,
  validateRedminePendingIntent,
  type ClientStatePort
} from "@feedback/redmine-core";

export function createBrowserClientState(options: {
  origin?: string;
  localStorage?: Storage;
  sessionStorage?: Storage;
  onFallback?: (error: unknown) => void;
} = {}): ClientStatePort {
  const memory = createMemoryClientState();
  let origin = options.origin ?? "opaque-origin";
  let local = options.localStorage as Storage;
  let session = options.sessionStorage as Storage;
  let accessError: unknown;
  try {
    origin = options.origin ?? globalThis.location?.origin ?? "opaque-origin";
    local = options.localStorage ?? globalThis.localStorage;
    session = options.sessionStorage ?? globalThis.sessionStorage;
  } catch (error) {
    accessError = error;
  }
  let fallback = Boolean(accessError);
  const unavailable = (error: unknown) => {
    if (!fallback) options.onFallback?.(error);
    fallback = true;
  };
  if (accessError) options.onFallback?.(accessError);
  const prefix = (profileId: string, principalScopeHash: string, kind: string) =>
    `feedback.redmine.v1:${origin}:${profileId}:${principalScopeHash}:${kind}`;
  const parse = (storage: Storage, key: string): unknown | null => {
    const value = storage.getItem(key);
    return value ? JSON.parse(value) as unknown : null;
  };
  const followIds = (profileId: string, principalScopeHash: string): string[] => {
    const value = parse(local, prefix(profileId, principalScopeHash, "follow-index"));
    if (value === null) return [];
    if (!Array.isArray(value) || value.length > 10_000 || value.some((item) => typeof item !== "string")) {
      throw new Error("follow indexが不正です");
    }
    return value;
  };

  return {
    async getFollowState(profileId, principalScopeHash, threadId) {
      if (fallback) return memory.getFollowState(profileId, principalScopeHash, threadId);
      try {
        const value = parse(local, prefix(profileId, principalScopeHash, `follow:${threadId}`));
        return value === null ? null : validateRedmineFollowState(value);
      } catch (error) {
        unavailable(error);
        return memory.getFollowState(profileId, principalScopeHash, threadId);
      }
    },
    async setFollowState(state) {
      await memory.setFollowState(state);
      if (fallback) return;
      try {
        const indexKey = prefix(state.profileId, state.principalScopeHash, "follow-index");
        const ids = new Set(followIds(state.profileId, state.principalScopeHash));
        ids.add(state.threadId);
        local.setItem(prefix(state.profileId, state.principalScopeHash, `follow:${state.threadId}`), JSON.stringify(state));
        local.setItem(indexKey, JSON.stringify([...ids].sort()));
      } catch (error) { unavailable(error); }
    },
    async listFollowStates(profileId, principalScopeHash) {
      if (fallback) return memory.listFollowStates(profileId, principalScopeHash);
      try {
        const ids = followIds(profileId, principalScopeHash);
        return ids.flatMap((threadId) => {
          const value = parse(local, prefix(profileId, principalScopeHash, `follow:${threadId}`));
          return value === null ? [] : [validateRedmineFollowState(value)];
        });
      } catch (error) {
        unavailable(error);
        return memory.listFollowStates(profileId, principalScopeHash);
      }
    },
    async getPendingIntent(profileId, principalScopeHash) {
      if (fallback) return memory.getPendingIntent(profileId, principalScopeHash);
      try {
        const key = prefix(profileId, principalScopeHash, "intent");
        const value = parse(local, key);
        if (value === null) return null;
        const intent = validateRedminePendingIntent(value);
        if (isExpiredPendingIntent(intent)) {
          local.removeItem(key);
          return null;
        }
        return intent;
      }
      catch (error) { unavailable(error); return memory.getPendingIntent(profileId, principalScopeHash); }
    },
    async setPendingIntent(profileId, principalScopeHash, intent) {
      await memory.setPendingIntent(profileId, principalScopeHash, intent);
      if (fallback) return;
      try {
        const key = prefix(profileId, principalScopeHash, "intent");
        if (intent) local.setItem(key, JSON.stringify(intent));
        else local.removeItem(key);
      } catch (error) { unavailable(error); }
    },
    async getDraft(profileId, principalScopeHash) {
      if (fallback) return memory.getDraft(profileId, principalScopeHash);
      try {
        const value = session.getItem(prefix(profileId, principalScopeHash, "draft"));
        if (value !== null && value.length > 20_000) throw new Error("draftが長すぎます");
        return value;
      }
      catch (error) { unavailable(error); return memory.getDraft(profileId, principalScopeHash); }
    },
    async setDraft(profileId, principalScopeHash, draft) {
      await memory.setDraft(profileId, principalScopeHash, draft);
      if (fallback) return;
      try {
        const key = prefix(profileId, principalScopeHash, "draft");
        if (draft === null) session.removeItem(key);
        else session.setItem(key, draft);
      } catch (error) { unavailable(error); }
    },
    async clearLocalState(profileId, principalScopeHash) {
      await memory.clearLocalState(profileId, principalScopeHash);
      if (fallback) return;
      try {
        const indexKey = prefix(profileId, principalScopeHash, "follow-index");
        const ids = followIds(profileId, principalScopeHash);
        ids.forEach((threadId) => local.removeItem(prefix(profileId, principalScopeHash, `follow:${threadId}`)));
        local.removeItem(indexKey);
        local.removeItem(prefix(profileId, principalScopeHash, "intent"));
        session.removeItem(prefix(profileId, principalScopeHash, "draft"));
      } catch (error) { unavailable(error); }
    }
  };
}
