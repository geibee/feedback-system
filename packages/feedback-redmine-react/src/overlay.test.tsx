import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import {
  createMemoryClientState,
  RedmineFeedbackError,
  sha256Hex,
  type FeedbackRedmineHostAdapter,
  type RedmineFeedbackPort,
  type RedmineThreadListResult,
  type RedmineThreadSummaryV1,
  type RedmineThreadV1
} from "@geibee/feedback-redmine-core";
import type { FeedbackLocationV1, FeedbackTargetResolver } from "@geibee/feedback-core";
import { createDomEvidenceProvider } from "./capture.js";
import { feedbackErrorMessage } from "./error-message.js";
import { addFeedbackCaptureMarker } from "./capture-marker.js";
import { RedmineFeedbackOverlay } from "./overlay.js";
import { RedmineFeedbackProvider, type RedmineFeedbackRuntime } from "./provider.js";

vi.mock("./capture.js", () => ({
  createDomEvidenceProvider: vi.fn(() => async () => ({
    bytes: new Uint8Array([1, 2, 3, 4]),
    contentType: "image/png",
    viewportWidth: 1,
    viewportHeight: 1,
    pixelRatio: 1,
    capturedAt: "2026-08-19T00:00:00Z"
  }))
}));

vi.mock("./capture-marker.js", () => ({
  addFeedbackCaptureMarker: vi.fn(async (payload) => payload)
}));

const threadId = "00000000-0000-4000-8000-000000000001";
const currentLocation: FeedbackLocationV1 = {
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
const summary: RedmineThreadSummaryV1 = {
  threadId,
  issueId: 123,
  subject: "[ux] 保存できない",
  initialComment: "最初のコメント",
  latestReply: "Redmineからの返信",
  status: { id: 1, name: "新規" },
  priority: { id: 2, name: "通常" },
  assignee: { id: 8, name: "担当者" },
  author: { id: 7, name: "投稿者" },
  perspectiveCode: "ux",
  locator: {
    v: "1",
    location: currentLocation,
    target: { schemaVersion: "1", kind: "screen-position", relativeX: 0.5, relativeY: 0.5 }
  },
  hasAttachments: true,
  createdAt: "2026-08-19T00:00:00Z",
  updatedAt: "2026-08-19T01:00:00Z"
};
const detail: RedmineThreadV1 = {
  ...summary,
  description: "最初のコメント",
  tracker: { id: 4, name: "Feedback" },
  timeline: [
    {
      kind: "reply",
      journalId: 10,
      body: "Redmineからの返信",
      author: { id: 9, name: "返信者" },
      createdAt: "2026-08-19T00:30:00Z",
      updatedAt: null
    },
    {
      kind: "activity",
      journalId: 10,
      field: "status",
      oldValue: "1",
      newValue: "2",
      author: { id: 9, name: "返信者" },
      createdAt: "2026-08-19T00:30:00Z"
    }
  ],
  attachments: [{
    id: 90,
    filename: "evidence.png",
    byteSize: 4,
    contentType: "image/png",
    author: { id: 7, name: "投稿者" },
    createdAt: "2026-08-19T00:00:00Z",
    inlinePreview: true,
    primaryEvidence: true
  }],
  redmineUrl: "https://redmine.example.invalid/issues/123",
  diagnosticCount: 0
};

function defaultAdapter(): FeedbackRedmineHostAdapter {
  return {
    getContext: () => ({
      schemaVersion: "1",
      applicationKey: "inventory",
      environmentKey: "production",
      externalWorkspaceKey: "production-review",
      release: "2026.08.19",
      locale: "ja-JP"
    }),
    getLocation: () => currentLocation,
    getResourceRef: () => ({ schemaVersion: "1", kind: "record", key: "order-1" }),
    navigate: () => undefined
  };
}

type SetupOptions = {
  clientProfile?: typeof profile;
  hostAdapter?: FeedbackRedmineHostAdapter;
  resourceResult?: RedmineThreadListResult;
  workspaceResult?: RedmineThreadListResult;
  workspaceNextResult?: RedmineThreadListResult;
  createError?: unknown;
  contextMenu?: boolean;
  targetResolver?: FeedbackTargetResolver<Element>;
  captureDiagnostics?: RedmineFeedbackRuntime["captureDiagnostics"];
};

function setup(threadDetail: RedmineThreadV1 = detail, options: SetupOptions = {}) {
  const clientProfile = options.clientProfile ?? profile;
  const hostAdapter = options.hostAdapter ?? defaultAdapter();
  const resourceResult = options.resourceResult ?? { threads: [summary], totalCount: 1, nextCursor: null };
  const workspaceResult = options.workspaceResult ?? { threads: [summary], totalCount: 1, nextCursor: null };
  const listThreads = vi.fn<RedmineFeedbackPort["listThreads"]>().mockImplementation(async (input) =>
    input.scope === "workspace"
      ? input.cursor ? options.workspaceNextResult ?? workspaceResult : workspaceResult
      : resourceResult
  );
  const allThreads = [...resourceResult.threads, ...workspaceResult.threads, ...(options.workspaceNextResult?.threads ?? [])];
  const getThread = vi.fn<RedmineFeedbackPort["getThread"]>().mockImplementation(async (input) => {
    const listed = allThreads.find((candidate) => candidate.threadId === input.threadId);
    return listed && listed.threadId !== threadDetail.threadId
      ? { ...threadDetail, ...listed, description: listed.initialComment, timeline: [], attachments: [] }
      : threadDetail;
  });
  const createThread = vi.fn<RedmineFeedbackPort["createThread"]>().mockResolvedValue(threadDetail);
  if (options.createError) createThread.mockRejectedValue(options.createError);
  const port: RedmineFeedbackPort = {
    getOrCreateParticipant: vi.fn().mockResolvedValue({
      participantId: "00000000-0000-4000-8000-000000000007",
      credential: "credential".repeat(8)
    }),
    getCapabilities: vi.fn().mockResolvedValue({
      profile: clientProfile,
      capabilities: { canRead: true, canCreate: true, canReply: true, canEditOwn: true, stateReadOnly: true }
    }),
    getCurrentUser: vi.fn().mockResolvedValue({
      participantId: "00000000-0000-4000-8000-000000000007",
      displayName: "利用者",
      source: "participant-credential"
    }),
    listThreads,
    getThread,
    createThread,
    createMessage: vi.fn().mockResolvedValue(threadDetail),
    updateMessage: vi.fn().mockResolvedValue(threadDetail),
    getAttachment: vi.fn().mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3, 4]),
      filename: "evidence.png",
      contentType: "image/png",
      sha256: "a".repeat(64)
    })
  };
  const clientState = createMemoryClientState();
  render(<RedmineFeedbackProvider runtime={{
    port,
    clientState,
    adapter: hostAdapter,
    profileId: clientProfile.id,
    contextMenu: options.contextMenu,
    targetResolver: options.targetResolver,
    captureDiagnostics: options.captureDiagnostics
  }}><RedmineFeedbackOverlay /></RedmineFeedbackProvider>);
  return { port, clientState, listThreads, getThread, createThread, hostAdapter };
}

async function openWorkspaceList() {
  fireEvent.click(await screen.findByRole("button", { name: /他の人の投稿を見る/u }));
  return screen.findByRole("dialog", { name: "他の人の投稿を見る" });
}

async function openThreadFromList() {
  const list = await openWorkspaceList();
  fireEvent.click(await within(list).findByRole("button", { name: /#123 UI\/UX/u }));
  return screen.findByRole("dialog", { name: "フィードバックスレッド" });
}

async function startComposer() {
  fireEvent.click(await screen.findByRole("button", { name: /フィードバック$/u }));
  expect((await screen.findByRole("status")).textContent).toMatch(/場所をクリック/u);
  fireEvent.click(document.body, { clientX: 100, clientY: 100 });
  return screen.findByRole("dialog", { name: "フィードバックの投稿" });
}

beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:test") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Redmine共通UI", () => {
  it("Redmine raw errorを表示せずerror codeを行動可能な日本語へ写像する", () => {
    const error = new RedmineFeedbackError("redmine.invalid_api_key", "raw upstream secret detail");
    expect(feedbackErrorMessage(error, "接続")).toMatch(/gatewayのRedmine認証設定/u);
    expect(feedbackErrorMessage(error, "接続")).not.toMatch(/options|API keyを再入力/u);
    expect(feedbackErrorMessage(error, "接続")).not.toMatch(/raw upstream/u);
  });

  it("旧React版と同じ2つのlauncherと独立したWorkspace一覧を表示する", async () => {
    const { listThreads } = setup();
    expect(await screen.findByRole("button", { name: /^フィードバック$/u })).toBeTruthy();
    const list = await openWorkspaceList();
    expect(within(list).getByText("Redmineからの返信")).toBeTruthy();
    expect(within(list).getByText("orders.detail")).toBeTruthy();
    expect(listThreads).toHaveBeenCalledWith(expect.objectContaining({ scope: "workspace" }), expect.anything());
  });

  it("Workspace cursorを同じqueryへ渡して追加表示する", async () => {
    const nextSummary = {
      ...summary,
      threadId: "00000000-0000-4000-8000-000000000002",
      issueId: 124,
      initialComment: "51件目",
      latestReply: null
    };
    const { listThreads } = setup(detail, {
      workspaceResult: { threads: [summary], totalCount: 2, nextCursor: "bound-cursor" },
      workspaceNextResult: { threads: [nextSummary], totalCount: 2, nextCursor: null }
    });
    const list = await openWorkspaceList();
    fireEvent.click(await within(list).findByRole("button", { name: "さらに読み込む" }));
    expect(await within(list).findByText("51件目")).toBeTruthy();
    expect(listThreads).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "workspace", cursor: "bound-cursor", sort: "updated_desc" }),
      expect.anything()
    );
  });

  it("詳細へreply/activityを表示し、証跡は明示操作後にだけ取得・表示する", async () => {
    const { port } = setup();
    const drawer = await openThreadFromList();
    expect(within(drawer).getAllByText(/Redmineからの返信/u).length).toBeGreaterThan(0);
    expect(within(drawer).getByText(/statusを変更/u)).toBeTruthy();
    expect(within(drawer).getByText(/evidence\.png/u)).toBeTruthy();
    expect(port.getAttachment).not.toHaveBeenCalled();
    fireEvent.click(within(drawer).getByRole("button", { name: "証跡" }));
    expect(await within(drawer).findByRole("img", { name: "証跡画像" })).toHaveProperty("src", "blob:test");
    fireEvent.click(within(drawer).getByRole("button", { name: "スレッドを閉じる" }));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
  });

  it("inline上限外の添付はdownload linkにする", async () => {
    setup({ ...detail, attachments: [{ ...detail.attachments[0]!, inlinePreview: false }] });
    const drawer = await openThreadFromList();
    fireEvent.click(within(drawer).getByRole("button", { name: "安全に取得" }));
    expect(await within(drawer).findByRole("link", { name: "ダウンロード" })).toHaveProperty("download", "evidence.png");
    expect(within(drawer).queryByRole("img")).toBeNull();
  });

  it("対象選択・キャンセル・外側操作・Escapeで独立ペインを開閉する", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: /^フィードバック$/u }));
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(screen.queryByRole("status")).toBeNull();
    await startComposer();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "フィードバックの投稿" })).toBeNull();
    const list = await openWorkspaceList();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "他の人の投稿を見る" })).toBeNull();
  });

  it("custom targetのproviderとkeyをReact textとして安全に表示する", async () => {
    setup(detail, {
      targetResolver: () => ({
        schemaVersion: "1",
        kind: "custom",
        provider: "com.example.threejs",
        targetKey: '<img src=x onerror="alert(1)">',
        fallbackRelativeX: 0.1,
        fallbackRelativeY: 0.2
      })
    });
    const composer = await startComposer();
    expect(within(composer).getByText('カスタム com.example.threejs / <img src=x onerror="alert(1)">')).toBeTruthy();
    expect(composer.querySelector("img")).toBeNull();
  });

  it("右クリックではmenuを表示し、選択後にcomposerを開く", async () => {
    setup(detail, { contextMenu: true });
    await screen.findByRole("button", { name: /^フィードバック$/u });
    fireEvent.contextMenu(document.body, { clientX: 30, clientY: 40 });
    const menuItem = await screen.findByRole("menuitem", { name: "フィードバックを残す" });
    expect(screen.queryByRole("dialog", { name: "フィードバックの投稿" })).toBeNull();
    fireEvent.click(menuItem);
    expect(await screen.findByRole("dialog", { name: "フィードバックの投稿" })).toBeTruthy();
  });

  it("位置付き投稿を作成し、retryable失敗ではpending intentを保持する", async () => {
    const { clientState } = setup(detail, {
      createError: new RedmineFeedbackError("redmine.unavailable", "network", { retryable: true })
    });
    const composer = await startComposer();
    fireEvent.change(within(composer).getByLabelText("最初のコメント"), { target: { value: "結果不明の投稿" } });
    fireEvent.click(within(composer).getByRole("button", { name: "Feedbackを送信" }));
    expect(await screen.findByText(/作成された可能性/u)).toBeTruthy();
    const scopeHash = await sha256Hex(new TextEncoder().encode(`${profile.id}\n00000000-0000-4000-8000-000000000007`));
    expect(await clientState.getPendingIntent(profile.id, scopeHash)).toMatchObject({ state: "uncertain" });
  });

  it("screenshotをmask指定で取得し、確認checkboxなしで自動添付する", async () => {
    const captureEvidence = vi.fn<NonNullable<FeedbackRedmineHostAdapter["captureEvidence"]>>().mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3, 4]),
      contentType: "image/png",
      viewportWidth: 1,
      viewportHeight: 1,
      pixelRatio: 1,
      capturedAt: "2026-08-19T00:00:00Z"
    });
    const captureProfile = { ...profile, capture: { ...profile.capture, enabled: true } };
    const { createThread } = setup(detail, {
      clientProfile: captureProfile,
      hostAdapter: { ...defaultAdapter(), captureEvidence }
    });
    const composer = await startComposer();
    expect(await within(composer).findByRole("img", { name: "証跡プレビュー" })).toHaveProperty("src", "blob:test");
    expect(within(composer).queryByRole("checkbox")).toBeNull();
    fireEvent.change(within(composer).getByLabelText("最初のコメント"), { target: { value: "画像付き指摘" } });
    fireEvent.click(within(composer).getByRole("button", { name: "Feedbackを送信" }));
    await waitFor(() => expect(createThread).toHaveBeenCalledTimes(1));
    const createInput = createThread.mock.calls[0]![0];
    expect(createInput.evidence).toMatchObject({ contentType: "image/png", byteSize: 4 });
    const threadUrl = new URL(createInput.threadUrl!);
    expect(threadUrl.origin).toBe(window.location.origin);
    expect(threadUrl.searchParams.get("feedbackThread")).toBe(createInput.threadId);
    expect(createThread.mock.calls[0]?.[1]).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      excludeSelector: "[data-feedback-redmine-ui]",
      maskSelector: "[data-feedback-mask]"
    }));
    expect(addFeedbackCaptureMarker).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: "image/png" }),
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) })
    );
  });

  it("既定captureへProfile上限を設定してからMapLibre providerで包む", async () => {
    const captureProfile = {
      ...profile,
      capture: { ...profile.capture, enabled: true, maximumUploadBytes: 1_048_576 }
    };
    const wrapProvider = vi.fn((provider) => provider);
    setup(detail, {
      clientProfile: captureProfile,
      captureDiagnostics: {
        wrapProvider,
        getWarning: () => null,
        subscribe: () => () => undefined
      }
    });

    const composer = await startComposer();
    expect(await within(composer).findByRole("img", { name: "証跡プレビュー" })).toBeTruthy();
    expect(createDomEvidenceProvider).toHaveBeenCalledWith({ maxBytes: 1_048_576 });
    expect(wrapProvider).toHaveBeenCalledWith(vi.mocked(createDomEvidenceProvider).mock.results[0]?.value);
  });

  it("別locationの投稿はnavigate完了とlocation一致後に詳細を取得する", async () => {
    const destination: FeedbackLocationV1 = {
      ...currentLocation,
      pathParameters: { orderId: "sha256:other" }
    };
    let location = currentLocation;
    const navigate = vi.fn(async () => { location = destination; });
    const crossThread = { ...summary, locator: { ...summary.locator!, location: destination } };
    const hostAdapter: FeedbackRedmineHostAdapter = {
      ...defaultAdapter(),
      getLocation: () => location,
      getResourceRef: () => ({ schemaVersion: "1", kind: "record", key: location === destination ? "order-2" : "order-1" }),
      navigate
    };
    const { getThread } = setup({ ...detail, ...crossThread }, {
      hostAdapter,
      workspaceResult: { threads: [crossThread], totalCount: 1, nextCursor: null }
    });
    await openThreadFromList();
    expect(navigate).toHaveBeenCalledWith(destination, threadId);
    expect(getThread).toHaveBeenCalledWith(expect.objectContaining({
      resourceRef: expect.objectContaining({ key: "order-2" })
    }), expect.anything());
  });
});
