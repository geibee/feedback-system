import type {
  FeedbackControllerLocalState,
  FeedbackControllerPendingStatePort,
  FeedbackPendingIntentSnapshot,
  FeedbackControllerStatePort
} from "./index.js";

export interface FeedbackBrowserStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type FeedbackBrowserControllerStateOptions = {
  origin: string;
  clientScopeId: string;
  localStorage: FeedbackBrowserStorage;
  legacySessionStorage?: FeedbackBrowserStorage;
  legacyPrincipalScopeHash?: string;
  now?: () => Date;
  onFallback?: (error: unknown) => void;
};

type StoredClientStateV2 = {
  schemaVersion: "2";
  profileId: string;
  clientScopeId: string;
  updatedAt: string;
  state: FeedbackControllerLocalState;
  pendingIntents?: readonly FeedbackPendingIntentSnapshot[];
};

const stableKey = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const scopeId = /^[A-Za-z0-9_-]{1,128}$/u;

export function feedbackClientStateV2Key(origin: string, profileId: string, clientScopeId: string): string {
  if (!origin || /[\u0000-\u001f\u007f]/u.test(origin)) throw new Error("originが不正です");
  if (!stableKey.test(profileId)) throw new Error("profileIdが不正です");
  if (!scopeId.test(clientScopeId)) throw new Error("clientScopeIdが不正です");
  return `feedback.v2:${origin}:${profileId}:${clientScopeId}:client-state`;
}

export function createMemoryFeedbackControllerState(
  initial: Readonly<Record<string, FeedbackControllerLocalState>> = {}
): FeedbackControllerStatePort & FeedbackControllerPendingStatePort {
  const states = new Map(Object.entries(initial).map(([profileId, state]) => [profileId, cloneState(validateLocalState(state))]));
  const pending = new Map<string, readonly FeedbackPendingIntentSnapshot[]>();
  return {
    async load(profileId) {
      const value = states.get(profileId);
      return value ? cloneState(value) : null;
    },
    async save(profileId, state) {
      states.set(profileId, cloneState(validateLocalState(state)));
    },
    async loadPendingIntents(profileId) {
      return clonePending(pending.get(profileId) ?? []);
    },
    async savePendingIntents(profileId, pendingIntents) {
      pending.set(profileId, clonePending(validatePendingIntents(pendingIntents, profileId)));
    }
  };
}

/**
 * v2 UX stateを現在browserのlocalStorageだけへ保存する。
 * browser storage拒否後はpage lifecycle内memoryへfail-softし、storage event同期は行わない。
 */
export function createBrowserFeedbackControllerState(
  options: FeedbackBrowserControllerStateOptions
): FeedbackControllerStatePort & FeedbackControllerPendingStatePort {
  if (!scopeId.test(options.clientScopeId)) throw new Error("clientScopeIdが不正です");
  const memory = createMemoryFeedbackControllerState();
  const now = options.now ?? (() => new Date());
  let fallback = false;
  const fail = (error: unknown) => {
    if (!fallback) options.onFallback?.(error);
    fallback = true;
  };
  return {
    async load(profileId) {
      if (fallback) return memory.load(profileId);
      const key = feedbackClientStateV2Key(options.origin, profileId, options.clientScopeId);
      try {
        const serialized = options.localStorage.getItem(key);
        if (serialized !== null) {
          const stored = validateStoredState(JSON.parse(serialized) as unknown, profileId, options.clientScopeId);
          await memory.save(profileId, stored.state);
          await memory.savePendingIntents(profileId, stored.pendingIntents ?? []);
          return cloneState(stored.state);
        }
        const migrated = readLegacyState(options, profileId);
        if (migrated === null) return null;
        const stored: StoredClientStateV2 = {
          schemaVersion: "2",
          profileId,
          clientScopeId: options.clientScopeId,
          updatedAt: now().toISOString(),
          state: migrated,
          pendingIntents: []
        };
        options.localStorage.setItem(key, JSON.stringify(stored));
        await memory.save(profileId, migrated);
        return cloneState(migrated);
      } catch (error) {
        fail(error);
        return memory.load(profileId);
      }
    },
    async save(profileId, state) {
      const validated = validateLocalState(state);
      await memory.save(profileId, validated);
      if (fallback) return;
      try {
        const stored: StoredClientStateV2 = {
          schemaVersion: "2",
          profileId,
          clientScopeId: options.clientScopeId,
          updatedAt: now().toISOString(),
          state: validated,
          pendingIntents: await memory.loadPendingIntents(profileId)
        };
        options.localStorage.setItem(
          feedbackClientStateV2Key(options.origin, profileId, options.clientScopeId),
          JSON.stringify(stored)
        );
      } catch (error) {
        fail(error);
      }
    },
    async loadPendingIntents(profileId) {
      if (fallback) return memory.loadPendingIntents(profileId);
      try {
        const serialized = options.localStorage.getItem(feedbackClientStateV2Key(options.origin, profileId, options.clientScopeId));
        if (serialized === null) return [];
        const stored = validateStoredState(JSON.parse(serialized) as unknown, profileId, options.clientScopeId);
        const pendingIntents = validatePendingIntents(stored.pendingIntents ?? [], profileId);
        await memory.savePendingIntents(profileId, pendingIntents);
        return clonePending(pendingIntents);
      } catch (error) {
        fail(error);
        return memory.loadPendingIntents(profileId);
      }
    },
    async savePendingIntents(profileId, pendingIntents) {
      const validated = validatePendingIntents(pendingIntents, profileId);
      await memory.savePendingIntents(profileId, validated);
      if (fallback) return;
      try {
        const key = feedbackClientStateV2Key(options.origin, profileId, options.clientScopeId);
        const serialized = options.localStorage.getItem(key);
        const existing = serialized === null ? null : validateStoredState(JSON.parse(serialized) as unknown, profileId, options.clientScopeId);
        const state = existing?.state ?? await memory.load(profileId);
        if (state === null) throw new Error("pending intentに対応するClientStateV2がありません");
        const stored: StoredClientStateV2 = {
          schemaVersion: "2",
          profileId,
          clientScopeId: options.clientScopeId,
          updatedAt: now().toISOString(),
          state,
          pendingIntents: validated
        };
        options.localStorage.setItem(key, JSON.stringify(stored));
      } catch (error) {
        fail(error);
      }
    }
  };
}

function readLegacyState(options: FeedbackBrowserControllerStateOptions, profileId: string): FeedbackControllerLocalState | null {
  const principal = options.legacyPrincipalScopeHash;
  if (!principal || !/^[a-f0-9]{64}$/u.test(principal)) return null;
  const prefix = `feedback.redmine.v1:${options.origin}:${profileId}:${principal}:`;
  const indexValue = options.localStorage.getItem(`${prefix}follow-index`);
  const draft = options.legacySessionStorage?.getItem(`${prefix}draft`) ?? "";
  if (draft.length > 20_000) throw new Error("legacy draftが長すぎます");
  if (indexValue === null && draft === "") return null;
  const followed: string[] = [];
  if (indexValue !== null) {
    const index = JSON.parse(indexValue) as unknown;
    if (!Array.isArray(index) || index.length > 10_000 || index.some((value) => typeof value !== "string" || !uuid.test(value))) {
      throw new Error("legacy follow indexが不正です");
    }
    for (const threadId of index) {
      const value = options.localStorage.getItem(`${prefix}follow:${threadId}`);
      if (value === null) continue;
      const candidate = JSON.parse(value) as unknown;
      if (typeof candidate !== "object" || candidate === null ||
        (candidate as { threadId?: unknown }).threadId !== threadId ||
        (candidate as { followed?: unknown }).followed !== true) continue;
      followed.push(threadId);
    }
  }
  return {
    draft,
    followedThreadIds: [...new Set(followed)].sort(),
    lastViewedByThread: {},
    unreadCountByThread: {}
  };
}

function validateStoredState(value: unknown, profileId: string, clientScopeId: string): StoredClientStateV2 {
  if (typeof value !== "object" || value === null) throw new Error("ClientStateV2がobjectではありません");
  const candidate = value as Partial<StoredClientStateV2>;
  if (candidate.schemaVersion !== "2" || candidate.profileId !== profileId || candidate.clientScopeId !== clientScopeId ||
    typeof candidate.updatedAt !== "string" || Number.isNaN(Date.parse(candidate.updatedAt)) || candidate.state === undefined) {
    throw new Error("ClientStateV2のbindingが不正です");
  }
  return { ...candidate, state: validateLocalState(candidate.state) } as StoredClientStateV2;
}

function validateLocalState(value: FeedbackControllerLocalState): FeedbackControllerLocalState {
  if (typeof value !== "object" || value === null || typeof value.draft !== "string" || value.draft.length > 100_000 ||
    !Array.isArray(value.followedThreadIds) || value.followedThreadIds.length > 10_000 ||
    value.followedThreadIds.some((threadId) => typeof threadId !== "string" || !uuid.test(threadId)) ||
    typeof value.lastViewedByThread !== "object" || value.lastViewedByThread === null ||
    typeof value.unreadCountByThread !== "object" || value.unreadCountByThread === null) {
    throw new Error("ClientStateV2 local stateが不正です");
  }
  if (value.threadReferences !== undefined) {
    if (!Array.isArray(value.threadReferences) || value.threadReferences.length > 1000) throw new Error("thread参照一覧が不正です");
    for (const entry of value.threadReferences) {
      if (!entry || !entry.scope || !entry.scope.resource || !stableKey.test(entry.scope.profileId) ||
          !stableKey.test(entry.scope.workspaceId) || !stableKey.test(entry.scope.resource.kind) ||
          typeof entry.scope.resource.key !== "string" || !entry.scope.resource.key || entry.scope.resource.key.length > 512 ||
          !uuid.test(entry.threadId) || !validReference(entry.threadReference)) throw new Error("thread参照bindingが不正です");
    }
  }
  const lastViewed: Record<string, { occurredAt: string; eventId: string }> = {};
  for (const [threadId, ordering] of Object.entries(value.lastViewedByThread)) {
    if (!uuid.test(threadId) || typeof ordering !== "object" || ordering === null ||
      typeof ordering.occurredAt !== "string" || Number.isNaN(Date.parse(ordering.occurredAt)) || !uuid.test(ordering.eventId)) {
      throw new Error("ClientStateV2 ordering keyが不正です");
    }
    lastViewed[threadId] = { occurredAt: ordering.occurredAt, eventId: ordering.eventId };
  }
  const unread: Record<string, number> = {};
  for (const [threadId, count] of Object.entries(value.unreadCountByThread)) {
    if (!uuid.test(threadId) || !Number.isSafeInteger(count) || count < 0 || count > 100_000) {
      throw new Error("ClientStateV2 unread countが不正です");
    }
    unread[threadId] = count;
  }
  return {
    ...(value.threadReferences ? { threadReferences: value.threadReferences.map((entry) => ({ ...entry, scope: { ...entry.scope, resource: { ...entry.scope.resource } } })) } : {}),
    draft: value.draft,
    followedThreadIds: [...new Set(value.followedThreadIds)].sort(),
    lastViewedByThread: lastViewed,
    unreadCountByThread: unread
  };
}

function cloneState(value: FeedbackControllerLocalState): FeedbackControllerLocalState {
  return {
    ...(value.threadReferences ? { threadReferences: value.threadReferences.map((entry) => ({ ...entry, scope: { ...entry.scope, resource: { ...entry.scope.resource } } })) } : {}),
    draft: value.draft,
    followedThreadIds: [...value.followedThreadIds],
    lastViewedByThread: Object.fromEntries(Object.entries(value.lastViewedByThread).map(([key, ordering]) => [key, { ...ordering }])),
    unreadCountByThread: { ...value.unreadCountByThread }
  };
}

function validatePendingIntents(
  value: readonly FeedbackPendingIntentSnapshot[],
  profileId: string
): readonly FeedbackPendingIntentSnapshot[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("pending intent一覧が不正です");
  const operations = new Set(["feedback:create", "feedback:reply", "feedback:revise", "feedback:attachment:upload"]);
  const seen = new Set<string>();
  for (const pending of value) {
    if (typeof pending !== "object" || pending === null || pending.scope.profileId !== profileId ||
      !stableKey.test(pending.scope.workspaceId) || !stableKey.test(pending.scope.resource.kind) ||
      typeof pending.scope.resource.key !== "string" || pending.scope.resource.key.length < 1 || pending.scope.resource.key.length > 512 ||
      !uuid.test(pending.threadId) || !uuid.test(pending.stableResultId) || !uuid.test(pending.intentId) ||
      !/^sha256:[a-f0-9]{64}$/u.test(pending.requestHash) || !operations.has(pending.operation) ||
      seen.has(pending.intentId) || pending.recovery.intentId !== pending.intentId ||
      pending.recovery.operation !== pending.operation ||
      (pending.retryPolicy !== "recover-only" && pending.retryPolicy !== "manual-confirmation")) {
      throw new Error("pending intentのbindingが不正です");
    }
    if (pending.retryPolicy === "manual-confirmation" &&
      (pending.recovery.state !== "repair_required" || pending.recovery.retryDirective !== "manual-confirmation")) {
      throw new Error("pending intentのretry policyが不正です");
    }
    if (pending.threadReference !== undefined && !validReference(pending.threadReference)) throw new Error("pending参照が不正です");
    seen.add(pending.intentId);
  }
  return value;
}

function clonePending(value: readonly FeedbackPendingIntentSnapshot[]): readonly FeedbackPendingIntentSnapshot[] {
  return value.map((pending) => ({
    ...pending,
    scope: { ...pending.scope, resource: { ...pending.scope.resource } },
    recovery: { ...pending.recovery }
  }));
}

function validReference(value: unknown): value is string {
  return typeof value === "string" && value.length <= 8192 && /^ftr1\.[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value);
}
