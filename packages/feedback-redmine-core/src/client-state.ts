export type RedmineFollowStateV1 = {
  schemaVersion: "1";
  profileId: string;
  principalScopeHash: string;
  threadId: string;
  issueId: number;
  followed: boolean;
  lastSeenJournalId: number;
  seenJournalIds?: number[];
  lastSeenIssueUpdatedOn: string;
  updatedAt: string;
};

export type RedminePendingIntentV1 = {
  schemaVersion: "1";
  profileId: string;
  threadId: string;
  intentId: string;
  clientDraftHash: string;
  createdAt: string;
  state: "prepared" | "uncertain";
};

export interface ClientStatePort {
  getFollowState(profileId: string, principalScopeHash: string, threadId: string): Promise<RedmineFollowStateV1 | null>;
  setFollowState(state: RedmineFollowStateV1): Promise<void>;
  listFollowStates(profileId: string, principalScopeHash: string): Promise<RedmineFollowStateV1[]>;
  getPendingIntent(profileId: string, principalScopeHash: string): Promise<RedminePendingIntentV1 | null>;
  setPendingIntent(profileId: string, principalScopeHash: string, intent: RedminePendingIntentV1 | null): Promise<void>;
  getDraft(profileId: string, principalScopeHash: string): Promise<string | null>;
  setDraft(profileId: string, principalScopeHash: string, draft: string | null): Promise<void>;
  clearLocalState(profileId: string, principalScopeHash: string): Promise<void>;
}

export function validateRedmineFollowState(value: unknown): RedmineFollowStateV1 {
  const item = exact(value, [
    "schemaVersion", "profileId", "principalScopeHash", "threadId", "issueId", "followed", "lastSeenJournalId",
    "lastSeenIssueUpdatedOn", "updatedAt"
  ], "follow state", ["seenJournalIds"]);
  if (item.schemaVersion !== "1" || typeof item.followed !== "boolean") throw new Error("follow stateが不正です");
  const seenJournalIds = item.seenJournalIds === undefined
    ? undefined
    : uniqueIntegerArray(item.seenJournalIds, "seen journal IDs", 1, 10_000);
  return {
    schemaVersion: "1",
    profileId: profileId(item.profileId),
    principalScopeHash: sha256(item.principalScopeHash, "principal scope hash"),
    threadId: uuid(item.threadId, "thread ID"),
    issueId: integer(item.issueId, "issue ID", 1),
    followed: item.followed,
    lastSeenJournalId: integer(item.lastSeenJournalId, "last seen journal ID", 0),
    ...(seenJournalIds === undefined ? {} : { seenJournalIds }),
    lastSeenIssueUpdatedOn: dateTime(item.lastSeenIssueUpdatedOn, "last seen issue updated on"),
    updatedAt: dateTime(item.updatedAt, "updated at")
  };
}

export function validateRedminePendingIntent(value: unknown): RedminePendingIntentV1 {
  const item = exact(
    value,
    ["schemaVersion", "profileId", "threadId", "intentId", "clientDraftHash", "createdAt", "state"],
    "pending intent"
  );
  if (item.schemaVersion !== "1" || (item.state !== "prepared" && item.state !== "uncertain")) {
    throw new Error("pending intentが不正です");
  }
  return {
    schemaVersion: "1",
    profileId: profileId(item.profileId),
    threadId: uuid(item.threadId, "thread ID"),
    intentId: uuid(item.intentId, "intent ID"),
    clientDraftHash: sha256(item.clientDraftHash, "client draft hash"),
    createdAt: dateTime(item.createdAt, "created at"),
    state: item.state
  };
}

export function createMemoryClientState(): ClientStatePort {
  const follow = new Map<string, RedmineFollowStateV1>();
  const pending = new Map<string, RedminePendingIntentV1>();
  const drafts = new Map<string, string>();
  const key = (profileId: string, principalScopeHash: string, threadId: string) =>
    `${profileId}\u0000${principalScopeHash}\u0000${threadId}`;
  return {
    async getFollowState(profileId, principalScopeHash, threadId) {
      return follow.get(key(profileId, principalScopeHash, threadId)) ?? null;
    },
    async setFollowState(state) {
      const validated = validateRedmineFollowState(state);
      follow.set(key(validated.profileId, validated.principalScopeHash, validated.threadId), structuredClone(validated));
    },
    async listFollowStates(profileId, principalScopeHash) {
      return [...follow.values()]
        .filter((state) => state.profileId === profileId && state.principalScopeHash === principalScopeHash)
        .map((state) => structuredClone(state));
    },
    async getPendingIntent(profileId, principalScopeHash) {
      const stateKey = key(profileId, sha256(principalScopeHash, "principal scope hash"), "pending");
      const intent = pending.get(stateKey) ?? null;
      if (intent && isExpiredPendingIntent(intent)) {
        pending.delete(stateKey);
        return null;
      }
      return intent;
    },
    async setPendingIntent(profileId, principalScopeHash, intent) {
      const stateKey = key(profileId, sha256(principalScopeHash, "principal scope hash"), "pending");
      if (intent) {
        const validated = validateRedminePendingIntent(intent);
        if (validated.profileId !== profileId) throw new Error("pending intentのprofile IDが一致しません");
        pending.set(stateKey, structuredClone(validated));
      } else pending.delete(stateKey);
    },
    async getDraft(profileId, principalScopeHash) {
      return drafts.get(key(profileId, sha256(principalScopeHash, "principal scope hash"), "draft")) ?? null;
    },
    async setDraft(profileId, principalScopeHash, draft) {
      const stateKey = key(profileId, sha256(principalScopeHash, "principal scope hash"), "draft");
      if (draft !== null && (typeof draft !== "string" || draft.length > 20_000)) throw new Error("draftが不正です");
      if (draft === null) drafts.delete(stateKey);
      else drafts.set(stateKey, draft);
    },
    async clearLocalState(profileId, principalScopeHash) {
      for (const [stateKey, state] of follow) {
        if (state.profileId === profileId && state.principalScopeHash === principalScopeHash) follow.delete(stateKey);
      }
      pending.delete(key(profileId, principalScopeHash, "pending"));
      drafts.delete(key(profileId, principalScopeHash, "draft"));
    }
  };
}

export function isExpiredPendingIntent(intent: RedminePendingIntentV1, now = Date.now()): boolean {
  return now - Date.parse(intent.createdAt) > 7 * 24 * 60 * 60 * 1_000;
}

function exact(
  value: unknown,
  keys: readonly string[],
  name: string,
  optionalKeys: readonly string[] = []
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name}がobjectではありません`);
  const item = value as Record<string, unknown>;
  const allowedKeys = [...keys, ...optionalKeys];
  if (Object.keys(item).some((key) => !allowedKeys.includes(key)) || keys.some((key) => !(key in item))) {
    throw new Error(`${name}のshapeが不正です`);
  }
  return item;
}

function profileId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,99}$/u.test(value)) throw new Error("profile IDが不正です");
  return value;
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error(`${name}がUUIDではありません`);
  }
  return value;
}

function sha256(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${name}がSHA-256ではありません`);
  return value;
}

function integer(value: unknown, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${name}がintegerではありません`);
  return value as number;
}

function uniqueIntegerArray(value: unknown, name: string, minimum: number, maximumItems: number): number[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error(`${name}がinteger arrayではありません`);
  const result = value.map((item) => integer(item, name, minimum));
  if (new Set(result).size !== result.length) throw new Error(`${name}に重複があります`);
  return result;
}

function dateTime(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length > 100 || !Number.isFinite(Date.parse(value))) throw new Error(`${name}がdate-timeではありません`);
  return value;
}

export function countUnreadReplies(
  journals: Array<{ id: number; notes: string; authorId: number | null }>,
  state: RedmineFollowStateV1,
  currentRedmineUserId: number | null
): number {
  if (!state.followed) return 0;
  const seenJournalIds = state.seenJournalIds === undefined ? null : new Set(state.seenJournalIds);
  return journals.filter(
    (journal) =>
      (seenJournalIds ? !seenJournalIds.has(journal.id) : journal.id > state.lastSeenJournalId) &&
      journal.notes.trim().length > 0 &&
      (currentRedmineUserId === null || journal.authorId !== currentRedmineUserId)
  ).length;
}
