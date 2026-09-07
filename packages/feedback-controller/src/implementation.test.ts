import { describe, expect, it, vi } from "vitest";
import type {
  FeedbackProfileV2,
  FeedbackThreadSummaryV2,
  FeedbackThreadV2
} from "@geibee/feedback-contracts/v2";
import { FeedbackClientProblem } from "@geibee/feedback-client";
import {
  createDeferredFeedbackClientResult,
  createFakeFeedbackClient,
  createTrackedUploadSource
} from "@geibee/feedback-client/testing";
import {
  createBrowserFeedbackControllerState,
  createFeedbackController,
  createMemoryFeedbackControllerState,
  feedbackClientStateV2Key,
  type FeedbackBrowserStorage,
  type FeedbackControllerRuntimeDependencies,
  type FeedbackControllerVisibilityPort
} from "./index.js";

const profileId = "inventory-production";
const threadId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5001";
const firstEventId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5004";
const replyEventId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5005";
const ownEventId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5006";
const scope = { profileId, workspaceId: "OPS", resource: { kind: "record", key: "order-001" } } as const;

const profile: FeedbackProfileV2 = {
  schemaVersion: "2",
  profileId,
  displayName: "Inventory / Production",
  capabilities: {
    backendOperations: ["feedback:read", "feedback:create", "feedback:reply", "feedback:revise", "feedback:attachment:upload"],
    discovery: { workspaces: "supported", resources: "supported" },
    operationGuarantees: { create: "recoverable", reply: "best-effort", revision: "best-effort", attachmentUpload: "best-effort" },
    creationFields: [], maximumAttachmentBytes: 10_485_760, attachmentContentTypes: ["image/png"]
  },
  effectivePermissions: ["feedback:read", "feedback:create", "feedback:attachment:upload"],
  externalNavigationPath: "/internal/feedback/v2/navigation"
};

const thread: FeedbackThreadV2 = {
  threadId,
  resource: scope.resource,
  title: "UI/UX",
  status: "open",
  createdAt: "2026-08-31T06:00:00.000Z",
  updatedAt: "2026-08-31T06:02:00.000Z",
  messageCount: 3,
  messages: [
    {
      messageId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5010",
      body: "最初の投稿",
      author: { kind: "provider-user", displayName: "利用者A" },
      createdAt: "2026-08-31T06:00:00.000Z",
      orderingKey: { occurredAt: "2026-08-31T06:00:00.000Z", eventId: firstEventId },
      revisions: [], attachments: []
    },
    {
      messageId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5011",
      body: "未読reply",
      author: { kind: "provider-user", displayName: "利用者B" },
      createdAt: "2026-08-31T06:01:00.000Z",
      orderingKey: { occurredAt: "2026-08-31T06:01:00.000Z", eventId: replyEventId },
      revisions: [], attachments: []
    },
    {
      messageId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5012",
      body: "自分のreply",
      author: {
        kind: "participant",
        participantId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5090",
        displayName: "自分",
        isCurrentParticipant: true
      },
      createdAt: "2026-08-31T06:02:00.000Z",
      orderingKey: { occurredAt: "2026-08-31T06:02:00.000Z", eventId: ownEventId },
      revisions: [], attachments: []
    }
  ]
};

const summary: FeedbackThreadSummaryV2 = (({ messages: _messages, ...value }) => value)(thread);

class MemoryStorage implements FeedbackBrowserStorage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function client(overrides: Parameters<typeof createFakeFeedbackClient>[0] = {}) {
  return createFakeFeedbackClient({
    async getProfile() { return profile; },
    async listWorkspaces() { return { items: [{ workspaceId: "OPS", displayName: "Operations" }], nextCursor: null }; },
    async listResources() { return { items: [{ resource: scope.resource, displayName: "Order 001" }], nextCursor: null }; },
    async listThreads() { return { items: [summary], nextCursor: null }; },
    async getThread() { return thread; },
    ...overrides
  });
}

function dependencies(options: {
  state?: FeedbackControllerRuntimeDependencies["state"];
  client?: ReturnType<typeof createFakeFeedbackClient>;
  capture?: FeedbackControllerRuntimeDependencies["capture"];
  visibility?: FeedbackControllerVisibilityPort;
  navigation?: FeedbackControllerRuntimeDependencies["navigation"];
  scheduler?: FeedbackControllerRuntimeDependencies["scheduler"];
  createId?: FeedbackControllerRuntimeDependencies["createId"];
  requestHash?: FeedbackControllerRuntimeDependencies["requestHash"];
} = {}): FeedbackControllerRuntimeDependencies {
  return {
    client: options.client ?? client(),
    state: options.state ?? createMemoryFeedbackControllerState(),
    capture: options.capture ?? { async capture() { return { filename: "capture.png", contentType: "image/png", contentHash: `sha256:${"1".repeat(64)}`, source: createTrackedUploadSource([]) }; }, cancel() {} },
    clock: { now: () => new Date("2026-08-31T06:03:00.000Z") },
    scheduler: options.scheduler ?? { schedule: () => () => undefined },
    createId: options.createId ?? (() => "018f0f58-c3d1-7a2b-8a4f-4c09571e5099"),
    visibility: options.visibility,
    navigation: options.navigation,
    requestHash: options.requestHash
  };
}

describe("ClientStateV2", () => {
  it("遅いfollow pollが新しい直接参照へ巻き戻しを起こさない", async () => {
    const deferred = createDeferredFeedbackClientResult<FeedbackThreadV2>();
    let reads = 0;
    const fake = client({
      async listThreads() { return { items: [{ ...summary, threadReference: "ftr1.k.a.b.c" }], nextCursor: null }; },
      async getThread() {
        reads += 1;
        if (reads === 1) return deferred.promise;
        return { ...thread, threadReference: "ftr1.k.d.e.f" };
      }
    });
    const controller = createFeedbackController(dependencies({ client: fake }));
    await controller.dispatch({ type: "connect", scope });
    await controller.dispatch({ type: "follow", threadId });
    const refreshing = controller.dispatch({ type: "refresh" });
    await vi.waitFor(() => expect(reads).toBe(1));
    await controller.dispatch({ type: "select-thread", threadId });
    deferred.resolve({ ...thread, threadReference: "ftr1.k.a.b.c" });
    await refreshing;
    expect(controller.getSnapshot().localState.threadReferences?.[0]?.threadReference).toBe("ftr1.k.d.e.f");
    await controller.dispatch({ type: "destroy" });
  });

  it("参照をscope別に保存し、一覧refreshによる別候補への切替を禁止し、remount後も回収に使う", async () => {
    const storage = new MemoryStorage();
    const state = () => createBrowserFeedbackControllerState({ origin: "https://app.example", clientScopeId: "browser", localStorage: storage });
    let listed = "ftr1.k.a.b.c";
    const observed: (string | undefined)[] = [];
    const fake = client({
      async getProfile() { return { ...profile, effectivePermissions: [...profile.effectivePermissions, "feedback:reply"] }; },
      async listThreads() { return { items: [{ ...summary, threadReference: listed }], nextCursor: null }; },
      async getThread(_query, options) { observed.push(options?.threadReference); return { ...thread, threadReference: options?.threadReference }; },
      async reply(query, options) {
        observed.push(options?.threadReference);
        return { intentId: query.command.intentId, operation: "feedback:reply", state: "pending", retryAfterSeconds: 5, automaticWriteAllowed: false };
      },
      async recoverIntent(query, options) {
        observed.push(options?.threadReference);
        return { intentId: query.intentId, operation: query.operation, state: "completed", stableResultId: threadId };
      }
    });
    const first = createFeedbackController(dependencies({ state: state(), client: fake }));
    await first.dispatch({ type: "connect", scope });
    await first.dispatch({ type: "select-thread", threadId });
    await first.dispatch({ type: "follow", threadId });
    listed = "ftr1.k.d.e.f";
    await first.dispatch({ type: "refresh" });
    await first.dispatch({ type: "reply", scope, threadId, command: {
      intentId: replyEventId, messageId: ownEventId, requestHash: "sha256:" + "1".repeat(64), body: "返信"
    } });
    expect(first.getSnapshot().pendingIntents[0]?.threadReference).toBe("ftr1.k.a.b.c");
    await first.dispatch({ type: "destroy" });
    const second = createFeedbackController(dependencies({ state: state(), client: fake }));
    await second.dispatch({ type: "connect", scope });
    await second.dispatch({ type: "recover-intent", intentId: replyEventId });
    expect(observed.length).toBeGreaterThan(3);
    expect(observed.every((token) => token === "ftr1.k.a.b.c")).toBe(true);
    await second.dispatch({ type: "destroy" });
  });

  it("v1の安全に変換できるfollow／draftだけを利用者scope付きv2 keyへ移行する", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const origin = "https://inventory.example.test";
    const principal = "a".repeat(64);
    const prefix = `feedback.redmine.v1:${origin}:${profileId}:${principal}:`;
    local.setItem(`${prefix}follow-index`, JSON.stringify([threadId]));
    local.setItem(`${prefix}follow:${threadId}`, JSON.stringify({ threadId, followed: true, lastSeenJournalId: 10 }));
    session.setItem(`${prefix}draft`, "移行するdraft");
    const state = createBrowserFeedbackControllerState({
      origin,
      clientScopeId: "participant-a",
      localStorage: local,
      legacySessionStorage: session,
      legacyPrincipalScopeHash: principal,
      now: () => new Date("2026-08-31T06:03:00.000Z")
    });

    await expect(state.load(profileId)).resolves.toEqual({
      draft: "移行するdraft",
      followedThreadIds: [threadId],
      lastViewedByThread: {},
      unreadCountByThread: {}
    });
    const v2Key = feedbackClientStateV2Key(origin, profileId, "participant-a");
    expect(JSON.parse(local.getItem(v2Key) ?? "null")).toMatchObject({ schemaVersion: "2", profileId, clientScopeId: "participant-a" });
    session.setItem(`${prefix}draft`, "旧keyの後発変更");
    await expect(state.load(profileId)).resolves.toMatchObject({ draft: "移行するdraft" });
    expect(local.getItem(`${prefix}follow:${threadId}`)).not.toBeNull();
  });

  it("storage拒否時だけmemoryへ退避し、別factoryや端末へ同期しない", async () => {
    const local = new MemoryStorage();
    const fallback = vi.fn();
    const broken = createBrowserFeedbackControllerState({ origin: "opaque-origin", clientScopeId: "a", localStorage: local, onFallback: fallback });
    const original = local.setItem.bind(local);
    local.setItem = () => { throw new Error("denied"); };
    await broken.save(profileId, { draft: "端末内", followedThreadIds: [], lastViewedByThread: {}, unreadCountByThread: {} });
    await expect(broken.load(profileId)).resolves.toMatchObject({ draft: "端末内" });
    expect(fallback).toHaveBeenCalledOnce();
    local.setItem = original;
    const other = createBrowserFeedbackControllerState({ origin: "opaque-origin", clientScopeId: "a", localStorage: local });
    await expect(other.load(profileId)).resolves.toBeNull();
  });
});

describe("Headless Feedback Controller", () => {
  it("golden契約に従ってconnectし、follow済みの他者replyだけを未読にして詳細表示で既読化する", async () => {
    const state = createMemoryFeedbackControllerState({
      [profileId]: {
        draft: "再現手順",
        followedThreadIds: [threadId],
        lastViewedByThread: { [threadId]: { occurredAt: "2026-08-31T06:00:00.000Z", eventId: firstEventId } },
        unreadCountByThread: { [threadId]: 0 }
      }
    });
    const controller = createFeedbackController(dependencies({ state }));
    await controller.dispatch({ type: "connect", scope });
    expect(controller.getSnapshot()).toMatchObject({
      schemaVersion: "2",
      lifecycle: "connected",
      pluginLifecycle: "mounted",
      profile: { profileId },
      discovery: { state: "ready", selectedWorkspaceId: "OPS", selectedResource: scope.resource },
      threads: { state: "ready", items: [summary] },
      localState: { draft: "再現手順", followedThreadIds: [threadId], unreadCountByThread: { [threadId]: 1 } }
    });

    await controller.dispatch({ type: "select-thread", threadId });
    expect(controller.getSnapshot().threads.selected?.threadId).toBe(threadId);
    expect(controller.getSnapshot().localState).toMatchObject({
      unreadCountByThread: { [threadId]: 0 },
      lastViewedByThread: { [threadId]: { eventId: ownEventId } }
    });
    await controller.dispatch({ type: "unfollow", threadId });
    expect(controller.getSnapshot().localState.followedThreadIds).toEqual([]);
  });

  it("connect／disconnect／remount／destroyのplugin lifecycleを固定する", async () => {
    const controller = createFeedbackController(dependencies());
    expect(controller.getSnapshot().pluginLifecycle).toBe("unmounted");
    await controller.dispatch({ type: "connect", scope });
    expect(controller.getSnapshot().pluginLifecycle).toBe("mounted");
    await controller.dispatch({ type: "disconnect" });
    expect(controller.getSnapshot()).toMatchObject({ lifecycle: "disconnected", pluginLifecycle: "unmounted" });
    await controller.dispatch({ type: "connect", scope });
    expect(controller.getSnapshot()).toMatchObject({ lifecycle: "connected", pluginLifecycle: "mounted" });
    await controller.dispatch({ type: "destroy" });
    expect(controller.getSnapshot()).toMatchObject({ lifecycle: "destroyed", pluginLifecycle: "destroyed" });
    await controller.dispatch({ type: "connect", scope });
    expect(controller.getSnapshot().lifecycle).toBe("destroyed");
  });

  it("capture cancel後の遅延結果とdisconnect後のread結果をcommitしない", async () => {
    const captureResult = createDeferredFeedbackClientResult<Awaited<ReturnType<FeedbackControllerRuntimeDependencies["capture"]["capture"]>>>();
    const capture = { capture: vi.fn(() => captureResult.promise), cancel: vi.fn() };
    const listResult = createDeferredFeedbackClientResult<{ items: FeedbackThreadSummaryV2[]; nextCursor: null }>();
    const fakeClient = client({ async listThreads() { return listResult.promise; } });
    const controller = createFeedbackController(dependencies({ client: fakeClient, capture }));
    const connecting = controller.dispatch({ type: "connect", scope });
    await Promise.resolve();
    await Promise.resolve();
    await controller.dispatch({ type: "disconnect" });
    listResult.resolve({ items: [summary], nextCursor: null });
    await connecting;
    expect(controller.getSnapshot().lifecycle).toBe("disconnected");

    capture.cancel.mockClear();
    const captureController = createFeedbackController(dependencies({ capture }));
    const capturing = captureController.dispatch({ type: "begin-evidence-capture" });
    await captureController.dispatch({ type: "cancel-evidence-capture" });
    captureResult.resolve({ filename: "late.png", contentType: "image/png", contentHash: `sha256:${"1".repeat(64)}`, source: createTrackedUploadSource([]) });
    await capturing;
    expect(captureController.getSnapshot().capture).toBe("cancelled");
    expect(captureController.getCapturedEvidence()).toBeNull();
    expect(capture.cancel).toHaveBeenCalledOnce();
  });

  it("capture成功結果を保持しfrozen upload commandへ同じsourceを一度だけ渡す", async () => {
    const source = createTrackedUploadSource([new Uint8Array([1, 2, 3])]);
    const evidence = {
      filename: "capture.png", contentType: "image/png",
      contentHash: `sha256:${"2".repeat(64)}`, source
    };
    const upload = vi.fn(async () => ({
      disposition: "created" as const,
      intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5072",
      attachment: {
        attachmentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5071",
        filename: "capture.png", contentType: "image/png", sizeBytes: 3,
        createdAt: "2026-08-31T06:03:00.000Z"
      }
    }));
    const writableProfile = {
      ...profile,
      effectivePermissions: [...profile.capabilities.backendOperations]
    };
    const fakeClient = client({ async getProfile() { return writableProfile; }, uploadAttachment: upload });
    const ids = [
      "018f0f58-c3d1-7a2b-8a4f-4c09571e5071",
      "018f0f58-c3d1-7a2b-8a4f-4c09571e5072"
    ];
    const controller = createFeedbackController(dependencies({
      client: fakeClient,
      capture: { async capture() { return evidence; }, cancel() {} },
      createId: () => ids.shift()!,
      requestHash: { async calculate() { return `sha256:${"3".repeat(64)}`; } }
    }));
    await controller.dispatch({ type: "connect", scope });
    await controller.dispatch({ type: "begin-evidence-capture" });
    expect(controller.getCapturedEvidence()).toBe(evidence);
    const command = await controller.createWriteCommand({ type: "upload-attachment", threadId });
    expect(command).toMatchObject({
      type: "upload-attachment", threadId,
      command: {
        attachmentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5071",
        intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5072",
        requestHash: `sha256:${"3".repeat(64)}`, contentHash: evidence.contentHash
      }
    });
    expect(command.type === "upload-attachment" && command.source).toBe(source);
    await controller.dispatch(command);
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ source }), expect.any(Object));
    expect(controller.getCapturedEvidence()).toBeNull();
    expect(controller.getSnapshot().capture).toBe("idle");
  });

  it("browser command生成をfrozen request hash vectorへ一致させる", async () => {
    const writableProfile = { ...profile, effectivePermissions: [...profile.capabilities.backendOperations] };
    const ids = [
      "018f0f58-c3d1-7a2b-8a4f-4c09571e5001",
      "018f0f58-c3d1-7a2b-8a4f-4c09571e5002"
    ];
    const controller = createFeedbackController(dependencies({
      client: client({ async getProfile() { return writableProfile; } }),
      createId: () => ids.shift()!
    }));
    await controller.dispatch({ type: "connect", scope });
    const command = await controller.createWriteCommand({ type: "submit", title: "表示崩れ", body: "再現手順" });
    expect(command).toEqual({
      type: "submit", profileId, workspaceId: "OPS",
      command: {
        threadId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5001",
        intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5002",
        requestHash: "sha256:b6438ac00c55095e68a8596f0dfd2708d580d38e6ec60e64764bd5ca93d2d8ce",
        resource: scope.resource, title: "表示崩れ", body: "再現手順"
      }
    });
  });

  it("hash生成中に切断されたstale writeと0 byte attachmentをfail-closedにする", async () => {
    const writableProfile = { ...profile, effectivePermissions: [...profile.capabilities.backendOperations] };
    const hash = createDeferredFeedbackClientResult<string>();
    const fakeClient = client({ async getProfile() { return writableProfile; } });
    const controller = createFeedbackController(dependencies({
      client: fakeClient,
      createId: (() => {
        const ids = [
          "018f0f58-c3d1-7a2b-8a4f-4c09571e5081",
          "018f0f58-c3d1-7a2b-8a4f-4c09571e5082"
        ];
        return () => ids.shift()!;
      })(),
      requestHash: { calculate: () => hash.promise }
    }));
    await controller.dispatch({ type: "connect", scope });
    const composing = controller.createWriteCommand({ type: "submit", title: "stale", body: "切断後は送らない" });
    await controller.dispatch({ type: "disconnect" });
    hash.resolve(`sha256:${"4".repeat(64)}`);
    const stale = await composing;
    await expect(controller.dispatch(stale)).rejects.toThrow(/scope/u);
    expect(fakeClient.count("createThread")).toBe(0);

    const emptyController = createFeedbackController(dependencies({
      client: fakeClient,
      capture: {
        async capture() {
          return {
            filename: "empty.png", contentType: "image/png",
            contentHash: `sha256:${"5".repeat(64)}`, source: createTrackedUploadSource([])
          };
        },
        cancel() {}
      }
    }));
    await emptyController.dispatch({ type: "connect", scope });
    await emptyController.dispatch({ type: "begin-evidence-capture" });
    await expect(emptyController.createWriteCommand({ type: "upload-attachment", threadId })).rejects.toThrow(/size/u);
  });

  it("navigation後のlocation不一致をfail-closedにしthread詳細を開かない", async () => {
    const fakeClient = client();
    const navigation = { request: vi.fn(async () => ({ locationMatches: false })) };
    const controller = createFeedbackController(dependencies({ client: fakeClient, navigation }));
    await controller.dispatch({ type: "connect", scope });
    const detailCalls = fakeClient.count("getThread");
    await controller.dispatch({ type: "request-navigation", threadId });
    expect(navigation.request).toHaveBeenCalledWith(expect.objectContaining({ path: "/internal/feedback/v2/navigation", threadId }));
    expect(fakeClient.count("getThread")).toBe(detailCalls);
    expect(controller.getSnapshot().threads.error?.code).toBe("feedback.invalid_request");
    expect(controller.getSnapshot().threads.selected).toBeNull();
  });

  it("attachment repair_required後はrecoverだけを行いbinaryを自動再uploadしない", async () => {
    const source = createTrackedUploadSource([new Uint8Array([1, 2, 3])]);
    const intentId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5031";
    const fakeClient = client({
      async uploadAttachment(query) {
        for await (const _chunk of query.source.stream()) { /* 一回だけ送信 */ }
        return {
          intentId,
          state: "repair_required",
          operation: "feedback:attachment:upload",
          detail: "結果不明のbinaryは自動再送しません",
          automaticWriteAllowed: false,
          retryDirective: "manual-confirmation"
        };
      },
      async recoverIntent() {
        return {
          intentId,
          state: "repair_required",
          operation: "feedback:attachment:upload",
          detail: "利用者確認が必要です",
          automaticWriteAllowed: false,
          retryDirective: "manual-confirmation"
        };
      }
    });
    const controller = createFeedbackController(dependencies({ client: fakeClient }));
    await controller.dispatch({ type: "connect", scope });
    await controller.dispatch({
      type: "upload-attachment", scope, threadId,
      command: {
        attachmentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5030",
        intentId, requestHash: `sha256:${"1".repeat(64)}`,
        filename: "phase3.png", contentType: "image/png", sizeBytes: 3,
        contentHash: `sha256:${"2".repeat(64)}`, purpose: "evidence"
      }, source
    });
    expect(controller.getSnapshot().pendingIntents[0]).toMatchObject({
      intentId,
      retryPolicy: "manual-confirmation",
      recovery: { state: "repair_required", automaticWriteAllowed: false }
    });
    await controller.dispatch({ type: "recover-intent", intentId });
    expect(fakeClient.count("uploadAttachment")).toBe(1);
    expect(fakeClient.count("recoverIntent")).toBe(1);
    expect(source.streamCalls).toBe(1);
  });

  it("retryableな結果不明をpendingへ保持し、同じintent metadataで回収する", async () => {
    const intentId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5051";
    const fakeClient = client({
      async createThread() {
        throw new FeedbackClientProblem({
          type: "https://feedback.example/problems/timeout", title: "timeout", status: 504,
          code: "feedback.provider_timeout", retryable: true, retryAfterSeconds: 2
        });
      },
      async recoverIntent(query) {
        expect(query).toMatchObject({ intentId, threadId, requestHash: `sha256:${"3".repeat(64)}`, operation: "feedback:create" });
        return { intentId, state: "completed", operation: "feedback:create", stableResultId: threadId };
      }
    });
    const local = new MemoryStorage();
    const browserState = () => createBrowserFeedbackControllerState({
      origin: "https://inventory.example.test",
      clientScopeId: "participant-a",
      localStorage: local
    });
    const controller = createFeedbackController(dependencies({ client: fakeClient, state: browserState() }));
    await controller.dispatch({ type: "connect", scope });
    await controller.dispatch({ type: "submit", profileId, workspaceId: "OPS", command: {
      intentId, requestHash: `sha256:${"3".repeat(64)}`, threadId, resource: scope.resource, title: "Timeout", body: "結果不明"
    } });
    expect(controller.getSnapshot().pendingIntents[0]).toMatchObject({ intentId, threadId, retryPolicy: "recover-only", recovery: { state: "pending", automaticWriteAllowed: false } });

    const reloaded = createFeedbackController(dependencies({ client: fakeClient, state: browserState() }));
    await reloaded.dispatch({ type: "connect", scope });
    expect(reloaded.getSnapshot().pendingIntents[0]).toMatchObject({ intentId, threadId, requestHash: `sha256:${"3".repeat(64)}` });
    await reloaded.dispatch({ type: "recover-intent", intentId });
    expect(fakeClient.count("createThread")).toBe(1);
    expect(reloaded.getSnapshot().pendingIntents).toEqual([]);
  });

  it("送信前にintentを永続化し、disconnect後も再接続で回収する", async () => {
    const state = createMemoryFeedbackControllerState();
    const deferred = createDeferredFeedbackClientResult<never>();
    const fakeClient = client({ async createThread(query) {
      expect(await state.loadPendingIntents(profileId)).toMatchObject([{ intentId: query.command.intentId }]);
      return deferred.promise;
    } });
    const controller = createFeedbackController(dependencies({ client: fakeClient, state }));
    await controller.dispatch({ type: "connect", scope });
    const command = await controller.createWriteCommand({ type: "submit", title: "切断", body: "本文" });
    const sending = controller.dispatch(command);
    await vi.waitFor(() => expect(fakeClient.count("createThread")).toBe(1));
    await controller.dispatch({ type: "disconnect" });
    deferred.reject(new Error("commit後に応答喪失"));
    await sending;
    const restored = createFeedbackController(dependencies({ client: fakeClient, state }));
    await restored.dispatch({ type: "connect", scope });
    expect(restored.getSnapshot().pendingIntents).toMatchObject([{ operation: "feedback:create", retryPolicy: "recover-only" }]);
    expect(fakeClient.count("createThread")).toBe(1);
  });

  it("pending保存が失敗した場合はproviderへ送信しない", async () => {
    const state = createMemoryFeedbackControllerState();
    state.savePendingIntents = async () => { throw new Error("保存不能"); };
    const fakeClient = client();
    const controller = createFeedbackController(dependencies({ client: fakeClient, state }));
    await controller.dispatch({ type: "connect", scope });
    await controller.dispatch(await controller.createWriteCommand({ type: "submit", title: "保存不能", body: "本文" }));
    expect(fakeClient.count("createThread")).toBe(0);
  });

  it("visibility復帰で即時refreshし、destroy通知後のasync callbackを禁止する", async () => {
    let visible = true;
    const visibilitySubscription: { current?: (visible: boolean) => void } = {};
    const visibility: FeedbackControllerVisibilityPort = {
      isVisible: () => visible,
      subscribe(listener) { visibilitySubscription.current = listener; return () => { delete visibilitySubscription.current; }; }
    };
    const cancellations: ReturnType<typeof vi.fn>[] = [];
    const scheduler = { schedule: vi.fn((_delay: number, _task: () => void) => {
      const cancel = vi.fn(); cancellations.push(cancel); return cancel;
    }) };
    const pending = createDeferredFeedbackClientResult<{ items: FeedbackThreadSummaryV2[]; nextCursor: null }>();
    let deferRefresh = false;
    const fakeClient = client({ async listThreads() { return deferRefresh ? pending.promise : { items: [summary], nextCursor: null }; } });
    const controller = createFeedbackController(dependencies({ client: fakeClient, visibility, scheduler }));
    const listener = vi.fn();
    controller.subscribe(listener);
    await controller.dispatch({ type: "connect", scope });
    expect(scheduler.schedule).toHaveBeenCalledWith(30_000, expect.any(Function));
    visible = false;
    visibilitySubscription.current?.(false);
    expect(cancellations[cancellations.length - 1]).toHaveBeenCalledOnce();
    deferRefresh = true;
    visible = true;
    visibilitySubscription.current?.(true);
    await Promise.resolve();
    const callbacksBeforeDestroy = listener.mock.calls.length;
    await controller.dispatch({ type: "destroy" });
    const callbacksAfterDestroy = listener.mock.calls.length;
    expect(callbacksAfterDestroy).toBe(callbacksBeforeDestroy + 1);
    pending.resolve({ items: [], nextCursor: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(callbacksAfterDestroy);
    expect(controller.getSnapshot()).toMatchObject({ lifecycle: "destroyed", pluginLifecycle: "destroyed" });
  });
});
