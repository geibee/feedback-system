import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FeedbackBrowserControllerPort,
  FeedbackControllerCommand,
  FeedbackControllerListener,
  FeedbackControllerPort,
  FeedbackControllerSnapshot,
  FeedbackControllerWriteCommand,
  FeedbackControllerWriteInput
} from "@geibee/feedback-controller";
import { FeedbackOverlay } from "./overlay.js";

const threadId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5001";

function connectedSnapshot(): FeedbackControllerSnapshot {
  return {
    schemaVersion: "2",
    lifecycle: "connected",
    pluginLifecycle: "mounted",
    profile: {
      schemaVersion: "2",
      profileId: "inventory-production",
      displayName: "Inventory / Production",
      capabilities: {
        backendOperations: ["feedback:read", "feedback:create"],
        discovery: { workspaces: "supported", resources: "supported" },
        operationGuarantees: { create: "recoverable", reply: "best-effort", revision: "best-effort", attachmentUpload: "best-effort" },
        creationFields: [], maximumAttachmentBytes: 1_048_576, attachmentContentTypes: ["image/png"]
      },
      effectivePermissions: ["feedback:read", "feedback:create"],
      externalNavigationPath: "/internal/feedback/v2/navigation"
    },
    discovery: {
      state: "ready",
      workspaces: [{ workspaceId: "OPS", displayName: "Operations" }],
      selectedWorkspaceId: "OPS",
      resources: [{ resource: { kind: "record", key: "order-001" }, displayName: "Order 001" }],
      selectedResource: { kind: "record", key: "order-001" }
    },
    threads: {
      state: "ready",
      items: [{
        threadId, resource: { kind: "record", key: "order-001" }, title: "保存できない", status: "open",
        createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:01:00.000Z", messageCount: 1
      }],
      nextCursor: "opaque-next",
      selected: null,
      refreshing: false,
      error: null
    },
    localState: { draft: "再現手順", followedThreadIds: [], lastViewedByThread: {}, unreadCountByThread: { [threadId]: 2 } },
    pendingIntents: [],
    targetSelection: "idle",
    capture: "idle",
    navigation: null
  };
}

function createRendererController(initial = connectedSnapshot()) {
  let snapshot = initial;
  const listeners = new Set<FeedbackControllerListener>();
  const commands: FeedbackControllerCommand[] = [];
  const controller: FeedbackControllerPort = {
    client: {} as FeedbackControllerPort["client"],
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async dispatch(command) { commands.push(command); }
  };
  return {
    commands,
    controller,
    emit(next: FeedbackControllerSnapshot) {
      snapshot = next;
      listeners.forEach((listener) => listener(snapshot));
    }
  };
}

afterEach(cleanup);

describe("Feedback React renderer", () => {
  it("snapshotだけを購読し、UI操作をcontroller commandとして発行する", async () => {
    const fixture = createRendererController();
    render(<FeedbackOverlay controller={fixture.controller} defaultOpen />);
    const dialog = screen.getByRole("dialog", { name: "Inventory / Production" });
    expect(within(dialog).getByLabelText("未読 2件")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: /保存できない/u }));
    fireEvent.change(within(dialog).getByLabelText("下書き"), { target: { value: "変更後" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "更新" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "続きを読み込む" }));

    expect(fixture.commands).toEqual([
      { type: "select-thread", threadId },
      { type: "update-draft", value: "変更後" },
      { type: "refresh" },
      { type: "load-more" }
    ]);
  });

  it("snapshot更新を描画し、follow、navigation、intent回収をcommandへ写像する", async () => {
    const fixture = createRendererController();
    render(<FeedbackOverlay controller={fixture.controller} defaultOpen />);
    const next = connectedSnapshot();
    next.threads.selected = {
      ...next.threads.items[0]!,
      messages: [{
        messageId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5002",
        body: "最初の投稿",
        author: { kind: "provider-user", displayName: "利用者" },
        createdAt: "2026-09-01T00:00:00.000Z",
        orderingKey: { occurredAt: "2026-09-01T00:00:00.000Z", eventId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5003" },
        revisions: [], attachments: []
      }]
    };
    next.pendingIntents = [{
      scope: { profileId: "inventory-production", workspaceId: "OPS", resource: { kind: "record", key: "order-001" } },
      threadId,
      stableResultId: threadId,
      intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5004",
      operation: "feedback:create",
      requestHash: `sha256:${"1".repeat(64)}`,
      recovery: {
        intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5004", state: "pending", operation: "feedback:create",
        retryAfterSeconds: 2, automaticWriteAllowed: false
      },
      retryPolicy: "recover-only"
    }];
    act(() => fixture.emit(next));

    fireEvent.click(screen.getByRole("checkbox", { name: "この端末でフォロー" }));
    fireEvent.click(screen.getByRole("button", { name: "関連画面へ移動" }));
    fireEvent.click(screen.getByRole("button", { name: "結果を確認" }));
    expect(fixture.commands.slice(-3)).toEqual([
      { type: "follow", threadId },
      { type: "request-navigation", threadId },
      { type: "recover-intent", intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5004" }
    ]);
  });

  it("launcher、Escape、focus復帰をdialogのkeyboard lifecycleとして維持する", async () => {
    const fixture = createRendererController();
    render(<FeedbackOverlay controller={fixture.controller} />);
    const launcher = screen.getByRole("button", { name: "フィードバック" });
    fireEvent.click(launcher);
    await waitFor(() => expect(screen.getByRole("button", { name: "閉じる" })).toBe(document.activeElement));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(launcher).toBe(document.activeElement));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("destroyed snapshotでは操作を無効化する", () => {
    const snapshot = connectedSnapshot();
    snapshot.lifecycle = "destroyed";
    snapshot.pluginLifecycle = "destroyed";
    const fixture = createRendererController(snapshot);
    render(<FeedbackOverlay controller={fixture.controller} defaultOpen />);
    expect((screen.getByLabelText("下書き") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "更新" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("command失敗時もhost callback失敗をrendererへ伝播しない", async () => {
    const fixture = createRendererController();
    const error = vi.fn(() => { throw new Error("host callback failure"); });
    fixture.controller.dispatch = vi.fn(async () => { throw new Error("dispatch failure"); });
    render(<FeedbackOverlay controller={fixture.controller} defaultOpen onCommandError={error} />);
    fireEvent.click(screen.getByRole("button", { name: "更新" }));
    await waitFor(() => expect(error).toHaveBeenCalledOnce());
  });

  it("browser compositionでsubmit／reply／reviseをfrozen commandへ変換してdispatchする", async () => {
    const fixture = createRendererController();
    const write = vi.fn(async (input: FeedbackControllerWriteInput) => ({ type: input.type } as FeedbackControllerWriteCommand));
    const runtime = fixture.controller as FeedbackBrowserControllerPort;
    runtime.createWriteCommand = write;
    runtime.getCapturedEvidence = () => null;
    const writable = connectedSnapshot();
    writable.profile = {
      ...writable.profile!,
      capabilities: {
        ...writable.profile!.capabilities,
        backendOperations: ["feedback:read", "feedback:create", "feedback:reply", "feedback:revise", "feedback:attachment:upload"]
      },
      effectivePermissions: ["feedback:read", "feedback:create", "feedback:reply", "feedback:revise", "feedback:attachment:upload"]
    };
    act(() => fixture.emit(writable));
    render(<FeedbackOverlay controller={runtime} defaultOpen />);

    fireEvent.change(screen.getByLabelText("件名"), { target: { value: "新規feedback" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith({ type: "submit", title: "新規feedback", body: "再現手順" }));

    const selected = connectedSnapshot();
    selected.profile = writable.profile;
    selected.localState = { ...selected.localState, draft: "返信本文" };
    selected.threads.selected = {
      ...selected.threads.items[0]!,
      messages: [{
        messageId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5002",
        body: "自分の投稿",
        author: {
          kind: "participant", participantId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5010",
          displayName: "自分", isCurrentParticipant: true
        },
        createdAt: "2026-09-01T00:00:00.000Z",
        orderingKey: { occurredAt: "2026-09-01T00:00:00.000Z", eventId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5002" },
        revisions: [{
          revisionId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5003", body: "自分の投稿",
          revisedAt: "2026-09-01T00:00:00.000Z",
          orderingKey: { occurredAt: "2026-09-01T00:00:00.000Z", eventId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5003" }
        }],
        attachments: []
      }]
    };
    act(() => fixture.emit(selected));
    fireEvent.click(screen.getByRole("button", { name: "返信" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith({ type: "reply", threadId, body: "返信本文" }));

    fireEvent.click(screen.getByRole("button", { name: "この投稿を編集" }));
    fireEvent.change(screen.getByLabelText("下書き"), { target: { value: "編集本文" } });
    act(() => fixture.emit({ ...selected, localState: { ...selected.localState, draft: "編集本文" } }));
    fireEvent.click(screen.getByRole("button", { name: "変更を保存" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith({
      type: "revise", threadId,
      messageId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5002",
      expectedRevisionId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5003",
      body: "編集本文"
    }));
    expect(fixture.commands.filter((command) => ["submit", "reply", "revise"].includes(command.type)).map((command) => command.type))
      .toEqual(["submit", "reply", "revise"]);
  });

  it("capture成功時だけ保持された証跡のupload commandを生成し、cancel時は生成しない", async () => {
    const selected = connectedSnapshot();
    selected.profile = {
      ...selected.profile!,
      capabilities: {
        ...selected.profile!.capabilities,
        backendOperations: ["feedback:read", "feedback:create", "feedback:attachment:upload"]
      },
      effectivePermissions: ["feedback:read", "feedback:create", "feedback:attachment:upload"]
    };
    selected.threads.selected = { ...selected.threads.items[0]!, messages: [] };
    const fixture = createRendererController(selected);
    const write = vi.fn(async (input: FeedbackControllerWriteInput) => ({ type: input.type } as FeedbackControllerWriteCommand));
    const runtime = fixture.controller as FeedbackBrowserControllerPort;
    runtime.createWriteCommand = write;
    runtime.getCapturedEvidence = () => null;
    runtime.dispatch = vi.fn(async (command) => {
      fixture.commands.push(command);
      if (command.type === "begin-evidence-capture") {
        act(() => fixture.emit({ ...selected, capture: "captured" }));
      }
    });
    render(<FeedbackOverlay controller={runtime} defaultOpen />);
    fireEvent.click(screen.getByRole("button", { name: "証跡を撮影" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith({ type: "upload-attachment", threadId }));
    expect(fixture.commands.map((command) => command.type)).toEqual(["begin-evidence-capture", "upload-attachment"]);

    write.mockClear();
    act(() => fixture.emit({ ...selected, capture: "capturing" }));
    fireEvent.click(screen.getByRole("button", { name: "撮影を中止" }));
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
    expect(fixture.commands[fixture.commands.length - 1]).toEqual({ type: "cancel-evidence-capture" });
  });
});
