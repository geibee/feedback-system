import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import {
  createMemoryClientState,
  RedmineFeedbackError,
  sha256Hex,
  type ClientStatePort,
  type FeedbackRedmineHostAdapter,
  type RedmineFeedbackPort,
  type RedmineThreadSummaryV1,
  type RedmineThreadV1
} from "@geibee/feedback-redmine-core";
import type { FeedbackEvidencePayload, FeedbackLocationV1 } from "@geibee/feedback-core";
import { RedmineFeedbackOverlay } from "./overlay.js";
import { RedmineFeedbackProvider } from "./provider.js";

const threadId = "00000000-0000-4000-8000-000000000001";
const participantId = "00000000-0000-4000-8000-000000000007";
const location: FeedbackLocationV1 = {
  schemaVersion: "1",
  pageKey: "orders.detail",
  routeTemplate: "/orders/{orderId}",
  pathParameters: { orderId: "sha256:value" }
};
const profile = {
  schemaVersion: "1" as const,
  id: "inventory-production",
  displayName: "Inventory / Production",
  applicationKey: "inventory",
  environmentKey: "production",
  externalWorkspaceKey: "production-review",
  perspectives: [{ code: "ux", label: "UI/UX" }],
  capture: { enabled: false, maximumUploadBytes: 10_485_760, contentTypes: ["image/png" as const] },
  attachments: { maximumInlinePreviewBytes: 10_485_760, maximumDownloadBytes: 52_428_800 },
  showRedmineLink: true
};
const summary = {
  threadId,
  issueId: 123,
  subject: "[ux] 保存できない",
  initialComment: "最初のコメント",
  latestReply: "未読の返信",
  status: { id: 1, name: "新規" },
  priority: { id: 2, name: "通常" },
  assignee: null,
  author: { id: 7, name: "投稿者" },
  perspectiveCode: "ux",
  locator: {
    v: "1" as const,
    location,
    target: { schemaVersion: "1" as const, kind: "screen-position" as const, relativeX: 0.5, relativeY: 0.5 }
  },
  hasAttachments: false,
  createdAt: "2026-08-19T00:00:00Z",
  updatedAt: "2026-08-19T02:00:00Z"
} satisfies RedmineThreadSummaryV1;
const detail = {
  ...summary,
  description: "最初のコメント",
  tracker: { id: 4, name: "Feedback" },
  timeline: [{
    kind: "reply" as const,
    journalId: 10,
    body: "未読の返信",
    author: { id: 9, name: "返信者" },
    createdAt: "2026-08-19T01:00:00Z",
    updatedAt: null
  }],
  attachments: [],
  redmineUrl: "https://redmine.example.invalid/issues/123",
  diagnosticCount: 0
} satisfies RedmineThreadV1;

function adapter(overrides: Partial<FeedbackRedmineHostAdapter> = {}): FeedbackRedmineHostAdapter {
  return {
    getContext: () => ({
      schemaVersion: "1",
      applicationKey: "inventory",
      environmentKey: "production",
      externalWorkspaceKey: "production-review",
      release: "2026.08.19",
      locale: "ja-JP"
    }),
    getLocation: () => location,
    getResourceRef: () => ({ schemaVersion: "1", kind: "record", key: "order-1" }),
    navigate: () => undefined,
    ...overrides
  };
}

function setup(options: {
  clientState?: ClientStatePort;
  clientProfile?: typeof profile;
  hostAdapter?: FeedbackRedmineHostAdapter;
  createThread?: ReturnType<typeof vi.fn<RedmineFeedbackPort["createThread"]>>;
} = {}) {
  const clientState = options.clientState ?? createMemoryClientState();
  const clientProfile = options.clientProfile ?? profile;
  const getThread = vi.fn<RedmineFeedbackPort["getThread"]>().mockResolvedValue(detail);
  const createThread = options.createThread ?? vi.fn<RedmineFeedbackPort["createThread"]>().mockResolvedValue(detail);
  const port: RedmineFeedbackPort = {
    getOrCreateParticipant: vi.fn().mockResolvedValue({ participantId, credential: "credential".repeat(8) }),
    getCapabilities: vi.fn().mockResolvedValue({
      profile: clientProfile,
      capabilities: { canRead: true, canCreate: true, canReply: true, canEditOwn: true, stateReadOnly: true }
    }),
    getCurrentUser: vi.fn().mockResolvedValue({
      participantId,
      displayName: "利用者",
      source: "participant-credential"
    }),
    getCreationOptions: vi.fn().mockResolvedValue({ optionalIssueFields: [], priorities: [] }),
    listThreads: vi.fn().mockResolvedValue({ threads: [summary], totalCount: 1, nextCursor: null }),
    getThread,
    createThread,
    createMessage: vi.fn().mockResolvedValue(detail),
    updateMessage: vi.fn().mockResolvedValue(detail),
    getAttachment: vi.fn().mockResolvedValue({
      bytes: new Uint8Array(),
      filename: "empty.bin",
      contentType: "application/octet-stream",
      sha256: "a".repeat(64)
    })
  };
  const hostAdapter = options.hostAdapter ?? adapter();
  const view = render(<RedmineFeedbackProvider runtime={{
    port,
    clientState,
    adapter: hostAdapter,
    profileId: clientProfile.id
  }}><RedmineFeedbackOverlay /></RedmineFeedbackProvider>);
  return { clientState, createThread, getThread, hostAdapter, port, view };
}

async function openWorkspaceThread() {
  fireEvent.click(await screen.findByRole("button", { name: /他の人の投稿を見る/u }));
  const list = await screen.findByRole("dialog", { name: "他の人の投稿を見る" });
  fireEvent.click(await within(list).findByRole("button", { name: /#123 UI\/UX/u }));
  return screen.findByRole("dialog", { name: "フィードバックスレッド" });
}

async function startComposer() {
  fireEvent.click(await screen.findByRole("button", { name: /^フィードバック$/u }));
  fireEvent.click(document.body, { clientX: 100, clientY: 100 });
  return screen.findByRole("dialog", { name: "フィードバックの投稿" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:phase0") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("Phase 0 UI characterization", () => {
  it("follow済みthreadの未読返信を表示し、詳細表示で既読化してfollow変更を保存する", async () => {
    const clientState = createMemoryClientState();
    const principalScopeHash = await sha256Hex(new TextEncoder().encode(`${profile.id}\n${participantId}`));
    await clientState.setFollowState({
      schemaVersion: "1",
      profileId: profile.id,
      principalScopeHash,
      threadId,
      issueId: 123,
      followed: true,
      lastSeenJournalId: 0,
      seenJournalIds: [],
      lastSeenIssueUpdatedOn: "2026-08-19T00:00:00Z",
      updatedAt: "2026-08-19T00:00:00Z"
    });
    setup({ clientState });

    expect(await screen.findByLabelText("未読の返信 1件")).toBeTruthy();
    const drawer = await openWorkspaceThread();
    const follow = await within(drawer).findByRole("checkbox", { name: /端末内の通知対象/u });
    expect(follow).toHaveProperty("checked", true);
    await waitFor(async () => expect(await clientState.getFollowState(profile.id, principalScopeHash, threadId))
      .toMatchObject({ followed: true, lastSeenJournalId: 10, seenJournalIds: [10] }));

    fireEvent.click(follow);
    await waitFor(async () => expect(await clientState.getFollowState(profile.id, principalScopeHash, threadId))
      .toMatchObject({ followed: false, seenJournalIds: [10] }));
  });

  it("結果不明の同一draft再送ではpending intentのthreadIdとintentIdを再利用する", async () => {
    const createThread = vi.fn<RedmineFeedbackPort["createThread"]>().mockRejectedValue(
      new RedmineFeedbackError("redmine.unavailable", "結果不明", { retryable: true })
    );
    const { clientState } = setup({ createThread });
    const composer = await startComposer();
    fireEvent.change(within(composer).getByLabelText("最初のコメント"), { target: { value: "同じ内容を再確認" } });

    fireEvent.click(within(composer).getByRole("button", { name: "Feedbackを送信" }));
    await waitFor(() => expect(createThread).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/作成された可能性/u)).toBeTruthy();
    fireEvent.click(within(composer).getByRole("button", { name: "Feedbackを送信" }));
    await waitFor(() => expect(createThread).toHaveBeenCalledTimes(2));

    expect(createThread.mock.calls[1]?.[0]).toMatchObject({
      threadId: createThread.mock.calls[0]?.[0].threadId,
      intentId: createThread.mock.calls[0]?.[0].intentId
    });
    const principalScopeHash = await sha256Hex(new TextEncoder().encode(`${profile.id}\n${participantId}`));
    expect(await clientState.getPendingIntent(profile.id, principalScopeHash)).toMatchObject({
      threadId: createThread.mock.calls[0]?.[0].threadId,
      intentId: createThread.mock.calls[0]?.[0].intentId,
      state: "uncertain"
    });
  });

  it("capture中にcomposerを閉じた場合は遅延結果をpreviewへcommitしない", async () => {
    const pendingCapture = deferred<FeedbackEvidencePayload | null>();
    const captureEvidence = vi.fn(() => pendingCapture.promise);
    setup({
      clientProfile: { ...profile, capture: { ...profile.capture, enabled: true } },
      hostAdapter: adapter({ captureEvidence })
    });
    const composer = await startComposer();
    expect(within(composer).getByText(/画面を取得しています/u)).toBeTruthy();
    fireEvent.click(within(composer).getByRole("button", { name: "キャンセル" }));

    await act(async () => {
      pendingCapture.resolve({
        bytes: new Uint8Array([1, 2, 3]),
        contentType: "image/png",
        viewportWidth: 100,
        viewportHeight: 100,
        pixelRatio: 1,
        capturedAt: "2026-08-19T00:00:00Z"
      });
      await pendingCapture.promise;
    });

    expect(screen.queryByRole("dialog", { name: "フィードバックの投稿" })).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("navigation後のlocation不一致ではthread詳細を開かず一覧へerrorを残す", async () => {
    const navigate = vi.fn(async () => undefined);
    const { getThread } = setup({ hostAdapter: adapter({
      getLocation: () => ({ ...location, pathParameters: { orderId: "sha256:current" } }),
      navigate
    }) });

    fireEvent.click(await screen.findByRole("button", { name: /他の人の投稿を見る/u }));
    const list = await screen.findByRole("dialog", { name: "他の人の投稿を見る" });
    fireEvent.click(await within(list).findByRole("button", { name: /#123 UI\/UX/u }));

    expect((await within(list).findByRole("alert")).textContent).toMatch(/画面移動を完了できません/u);
    expect(navigate).toHaveBeenCalledWith(location, threadId);
    expect(getThread).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "フィードバックスレッド" })).toBeNull();
  });
});
