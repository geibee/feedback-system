import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import {
  createMemoryClientState,
  RedmineFeedbackError,
  sha256Hex,
  type FeedbackRedmineHostAdapter,
  type RedmineFeedbackPort,
  type RedmineThreadSummaryV1,
  type RedmineThreadV1
} from "@feedback/redmine-core";
import { RedmineFeedbackOverlay } from "./overlay.js";
import { RedmineFeedbackProvider } from "./provider.js";
import { feedbackErrorMessage } from "./error-message.js";

const threadId = "00000000-0000-4000-8000-000000000001";
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
  latestReply: null,
  status: { id: 1, name: "新規" },
  priority: { id: 2, name: "通常" },
  assignee: { id: 8, name: "担当者" },
  author: { id: 7, name: "投稿者" },
  perspectiveCode: "ux",
  locator: null,
  hasAttachments: true,
  createdAt: "2026-08-19T00:00:00Z",
  updatedAt: "2026-08-19T01:00:00Z"
};
const detail: RedmineThreadV1 = {
  ...summary,
  latestReply: "Redmineからの返信",
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

const adapter: FeedbackRedmineHostAdapter = {
  getContext: () => ({
    schemaVersion: "1",
    applicationKey: "inventory",
    environmentKey: "production",
    externalWorkspaceKey: "production-review",
    release: "2026.08.19",
    locale: "ja-JP"
  }),
  getLocation: () => ({
    schemaVersion: "1",
    pageKey: "orders.detail",
    routeTemplate: "/orders/{orderId}",
    pathParameters: { orderId: "sha256:value" }
  }),
  getResourceRef: () => ({ schemaVersion: "1", kind: "record", key: "order-1" }),
  navigate: () => undefined
};

function setup(
  threadDetail: RedmineThreadV1 = detail,
  options: {
    clientProfile?: typeof profile;
    hostAdapter?: FeedbackRedmineHostAdapter;
    listResults?: Array<{ threads: RedmineThreadSummaryV1[]; nextCursor: string | null }>;
    createError?: unknown;
  } = {}
) {
  const clientProfile = options.clientProfile ?? profile;
  const hostAdapter = options.hostAdapter ?? adapter;
  const listThreads = vi.fn<RedmineFeedbackPort["listThreads"]>();
  for (const result of options.listResults ?? [{ threads: [summary], nextCursor: null }]) {
    listThreads.mockResolvedValueOnce(result);
  }
  listThreads.mockResolvedValue({ threads: [summary], nextCursor: null });
  const listedThreads = options.listResults?.flatMap((result) => result.threads) ?? [];
  const getThread = vi.fn<RedmineFeedbackPort["getThread"]>().mockImplementation(async (input) => {
    const listed = listedThreads.find((candidate) => candidate.threadId === input.threadId);
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
    profileId: clientProfile.id
  }}><RedmineFeedbackOverlay /></RedmineFeedbackProvider>);
  return { port, clientState, listThreads, getThread, createThread };
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
    expect(feedbackErrorMessage(error, "接続")).toMatch(/API keyを再入力/u);
    expect(feedbackErrorMessage(error, "接続")).not.toMatch(/raw upstream/u);
    expect(feedbackErrorMessage(
      new RedmineFeedbackError("redmine.duplicate_thread_id", "raw duplicate"),
      "詳細"
    )).toMatch(/Redmine管理者/u);
  });

  it("最初のcommentを主表示し最新replyを補助表示する", async () => {
    const { listThreads } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Feedbackを開く" }));
    expect(await screen.findByText("最初のコメント")).toBeTruthy();
    expect(await screen.findByText("最新の返信: Redmineからの返信")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("並び順"), { target: { value: "created_asc" } });
    await waitFor(() => expect(screen.getByLabelText("並び順")).toHaveProperty("value", "created_asc"));
    const beforeReopen = listThreads.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Feedbackを開く" }));
    fireEvent.click(screen.getByRole("button", { name: "Feedbackを開く" }));
    await waitFor(() => expect(listThreads.mock.calls.length).toBeGreaterThan(beforeReopen));
  });

  it("next cursorを同じqueryへ渡して50件目以降を追加表示する", async () => {
    const nextSummary = { ...summary, threadId: "00000000-0000-4000-8000-000000000002", initialComment: "51件目" };
    const { listThreads } = setup(detail, {
      listResults: [
        { threads: [summary], nextCursor: "bound-cursor" },
        { threads: [nextSummary], nextCursor: null }
      ]
    });
    fireEvent.click(screen.getByRole("button", { name: "Feedbackを開く" }));
    const loadMoreButton = await screen.findByRole("button", { name: "さらに読み込む" });
    await waitFor(() => expect(listThreads.mock.calls.length).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect((loadMoreButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(loadMoreButton);
    expect(await screen.findByText("51件目")).toBeTruthy();
    await waitFor(() => expect(listThreads).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "bound-cursor", sort: "updated_desc" }),
      expect.anything()
    ));
    expect(screen.queryByRole("button", { name: "さらに読み込む" })).toBeNull();
  });

  it("全reply/activity/attachmentをdrawerへ表示して返信できる", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Feedbackを開く" }));
    fireEvent.click(await screen.findByRole("button", { name: /新規.*最初のコメント.*最新の返信/su }));
    expect((await screen.findAllByText(/Redmineからの返信/u)).length).toBeGreaterThan(0);
    expect(screen.getByText(/statusを変更/u)).toBeTruthy();
    expect(screen.getByText(/evidence\.png/u)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Redmineで開く" })).toHaveProperty("rel", "noopener noreferrer");
    expect(screen.getByRole("textbox", { name: /返信/u })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /resolve|reopen|reaction|triage/iu })).toBeNull();
  });

  it("inline上限外の画像をdownload linkにしdrawer closeでBlob URLを破棄する", async () => {
    setup({ ...detail, attachments: [{ ...detail.attachments[0]!, inlinePreview: false }] });
    fireEvent.click(screen.getByRole("button", { name: "Feedbackを開く" }));
    fireEvent.click(await screen.findByRole("button", { name: /新規.*最初のコメント/su }));
    fireEvent.click(await screen.findByRole("button", { name: "安全に取得" }));
    expect(await screen.findByRole("link", { name: "ダウンロード" })).toHaveProperty("download", "evidence.png");
    expect(screen.queryByRole("img", { name: "evidence.png" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
  });

  it("Feedback UIから位置付き投稿を作成する", async () => {
    const { createThread } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Feedbackを開く" }));
    const textarea = await screen.findByLabelText("最初のコメント");
    fireEvent.change(textarea, { target: { value: "新しい指摘" } });
    fireEvent.click(screen.getByRole("button", { name: "場所を選択" }));
    fireEvent.click(document.body, { clientX: 100, clientY: 100 });
    fireEvent.click(screen.getByRole("button", { name: "Feedbackを送信" }));
    await waitFor(() => expect(createThread).toHaveBeenCalledTimes(1));
    expect(createThread.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      comment: "新しい指摘",
      perspectiveCode: "ux"
    }));
    expect(createThread.mock.calls[0]?.[0].target).toMatchObject({ kind: "screen-position" });
  });

  it("投稿結果不明ではpending intentをuncertainのまま保持する", async () => {
    const { clientState } = setup(detail, {
      createError: new RedmineFeedbackError("redmine.unavailable", "network", { retryable: true })
    });
    fireEvent.click(screen.getByRole("button", { name: "Feedbackを開く" }));
    fireEvent.change(await screen.findByLabelText("最初のコメント"), { target: { value: "結果不明の投稿" } });
    fireEvent.click(screen.getByRole("button", { name: "場所を選択" }));
    fireEvent.click(document.body, { clientX: 100, clientY: 100 });
    fireEvent.click(screen.getByRole("button", { name: "Feedbackを送信" }));
    expect(await screen.findByText(/作成された可能性/u)).toBeTruthy();
    const scopeHash = await sha256Hex(new TextEncoder().encode(`${profile.id}\n00000000-0000-4000-8000-000000000007`));
    expect(await clientState.getPendingIntent(profile.id, scopeHash)).toMatchObject({
      clientDraftHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      state: "uncertain"
    });
  });

  it("screenshotをmask指定でpreviewし、明示consent後だけ送信してBlob URLを破棄する", async () => {
    const captureEvidence = vi.fn<NonNullable<FeedbackRedmineHostAdapter["captureEvidence"]>>().mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3, 4]),
      contentType: "image/png",
      viewportWidth: 1,
      viewportHeight: 1,
      pixelRatio: 1,
      capturedAt: "2026-08-19T00:00:00Z"
    });
    const captureProfile = { ...profile, capture: { ...profile.capture, enabled: true } };
    const { createThread } = setup(detail, { clientProfile: captureProfile, hostAdapter: { ...adapter, captureEvidence } });
    fireEvent.click(screen.getByRole("button", { name: "Feedbackを開く" }));
    fireEvent.change(await screen.findByLabelText("最初のコメント"), { target: { value: "画像付き指摘" } });
    fireEvent.click(screen.getByRole("button", { name: "場所を選択" }));
    fireEvent.click(document.body, { clientX: 100, clientY: 100 });
    expect(await screen.findByRole("img", { name: "送信前スクリーンショット" })).toHaveProperty("src", "blob:test");
    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      excludeSelector: "[data-feedback-redmine-ui]",
      maskSelector: "[data-feedback-mask]"
    }));
    const submit = screen.getByRole("button", { name: "Feedbackを送信" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(screen.getByLabelText("この画像をRedmineへ送信する"));
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(createThread).toHaveBeenCalledTimes(1));
    expect(createThread.mock.calls[0]?.[0].evidence).toEqual(expect.objectContaining({
      contentType: "image/png",
      byteSize: 4,
      viewportWidth: 1,
      viewportHeight: 1
    }));
    expect(createThread.mock.calls[0]?.[1]).toEqual(new Uint8Array([1, 2, 3, 4]));
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test"));
  });
});
