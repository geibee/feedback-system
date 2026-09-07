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
import { FeedbackElement, defineFeedbackWebComponent, feedbackElementName } from "./element.js";
import { createFeedbackPlugin } from "./plugin.js";

const threadId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5001";

function snapshot(): FeedbackControllerSnapshot {
  return {
    schemaVersion: "2",
    lifecycle: "connected",
    pluginLifecycle: "mounted",
    profile: {
      schemaVersion: "2", profileId: "inventory-production", displayName: "Inventory / Production",
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
      state: "ready", workspaces: [{ workspaceId: "OPS", displayName: "Operations" }], selectedWorkspaceId: "OPS",
      resources: [{ resource: { kind: "record", key: "order-001" }, displayName: "Order 001" }],
      selectedResource: { kind: "record", key: "order-001" }
    },
    threads: {
      state: "ready",
      items: [{
        threadId, resource: { kind: "record", key: "order-001" }, title: "保存できない", status: "open",
        createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:01:00.000Z", messageCount: 1
      }],
      nextCursor: null, selected: null, refreshing: false, error: null
    },
    localState: { draft: "再現手順", followedThreadIds: [], lastViewedByThread: {}, unreadCountByThread: { [threadId]: 2 } },
    pendingIntents: [], targetSelection: "idle", capture: "idle", navigation: null
  };
}

function controller(initial = snapshot(), implementation?: (command: FeedbackControllerCommand) => Promise<void>) {
  let current = initial;
  const listeners = new Set<FeedbackControllerListener>();
  const commands: FeedbackControllerCommand[] = [];
  const value: FeedbackControllerPort = {
    client: {} as FeedbackControllerPort["client"],
    getSnapshot: () => current,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async dispatch(command) {
      commands.push(command);
      await implementation?.(command);
    }
  };
  return {
    commands,
    listeners,
    value,
    emit(next: FeedbackControllerSnapshot) { current = next; listeners.forEach((listener) => listener(current)); }
  };
}

afterEach(() => document.body.replaceChildren());

describe("Feedback Web Component", () => {
  it("open Shadow DOMへsnapshotを描画し、host CSSとDOM event handlerから隔離する", () => {
    defineFeedbackWebComponent();
    const element = document.createElement(feedbackElementName) as FeedbackElement;
    element.setAttribute("style-nonce", "phase4-nonce");
    element.controller = controller().value;
    document.body.append(element);
    expect(element.shadowRoot).toBeTruthy();
    expect(element.shadowRoot?.querySelector("style")?.nonce).toBe("phase4-nonce");
    expect(element.shadowRoot?.querySelectorAll("[style]")).toHaveLength(0);
    expect(element.shadowRoot?.querySelectorAll("[onclick],[oninput],[onkeydown]")).toHaveLength(0);
    expect(element.querySelector("button")).toBeNull();
  });

  it("keyboard、focus、ARIAとcommand写像を維持する", async () => {
    defineFeedbackWebComponent();
    const fixture = controller();
    const element = document.createElement(feedbackElementName) as FeedbackElement;
    element.controller = fixture.value;
    document.body.append(element);
    const root = element.shadowRoot!;
    const launcher = root.querySelector<HTMLButtonElement>(".launcher")!;
    launcher.click();
    await Promise.resolve();
    const dialog = root.querySelector<HTMLElement>("[role=dialog]")!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(root.activeElement?.getAttribute("aria-label")).toBe("閉じる");
    root.querySelector<HTMLButtonElement>(".thread")!.click();
    const draft = root.querySelector<HTMLTextAreaElement>("textarea")!;
    draft.value = "変更後";
    draft.dispatchEvent(new Event("input", { bubbles: true }));
    expect(fixture.commands).toEqual([
      { type: "select-thread", threadId },
      { type: "update-draft", value: "変更後" }
    ]);
    const currentDialog = root.querySelector<HTMLElement>("[role=dialog]")!;
    const currentDraft = root.querySelector<HTMLTextAreaElement>("textarea")!;
    currentDraft.focus();
    currentDialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(root.activeElement?.getAttribute("aria-label")).toBe("閉じる");
    currentDialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
    expect(root.querySelector("[role=dialog]")).toBeNull();
    expect((root.activeElement as HTMLElement | null)?.dataset.feedbackFocus).toBe("launcher");
  });

  it("snapshot更新後も入力focusを維持し、disconnect中は購読を解除する", async () => {
    defineFeedbackWebComponent();
    const fixture = controller();
    const element = document.createElement(feedbackElementName) as FeedbackElement;
    element.controller = fixture.value;
    element.open = true;
    document.body.append(element);
    const draft = element.shadowRoot!.querySelector<HTMLTextAreaElement>("textarea")!;
    draft.focus();
    const next = snapshot();
    next.localState = { ...next.localState, draft: "server snapshot" };
    fixture.emit(next);
    await Promise.resolve();
    expect((element.shadowRoot!.activeElement as HTMLElement | null)?.dataset.feedbackFocus).toBe("draft");
    expect(element.shadowRoot!.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("server snapshot");
    element.remove();
    expect(fixture.listeners.size).toBe(0);
  });

  it("command失敗をtyped eventで通知し、destroy後の遅延失敗は通知しない", async () => {
    defineFeedbackWebComponent();
    let reject!: (error: unknown) => void;
    const deferred = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const fixture = controller(snapshot(), async (command) => command.type === "refresh" ? deferred : undefined);
    const element = document.createElement(feedbackElementName) as FeedbackElement;
    element.controller = fixture.value;
    document.body.append(element);
    const errors = vi.fn();
    element.addEventListener("feedback-command-error", errors);
    const refreshing = element.refresh();
    element.destroyRenderer();
    reject(new Error("late failure"));
    await refreshing;
    expect(errors).not.toHaveBeenCalled();
    expect(element.shadowRoot?.childNodes).toHaveLength(0);
  });

  it("browser compositionでsubmit／reply／reviseを同じfrozen commandへ写像する", async () => {
    defineFeedbackWebComponent();
    const initial = writableSnapshot();
    const fixture = controller(initial);
    const runtime = fixture.value as FeedbackBrowserControllerPort;
    const write = vi.fn(async (input: FeedbackControllerWriteInput) => ({ type: input.type } as FeedbackControllerWriteCommand));
    runtime.createWriteCommand = write;
    runtime.getCapturedEvidence = () => null;
    const element = document.createElement(feedbackElementName) as FeedbackElement;
    element.controller = runtime;
    element.open = true;
    document.body.append(element);
    const root = element.shadowRoot!;

    const title = root.querySelector<HTMLInputElement>("[data-feedback-focus=title]")!;
    title.value = "新規feedback";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLButtonElement>("[data-feedback-focus=submit]")!.click();
    await Promise.resolve();
    expect(write).toHaveBeenCalledWith({ type: "submit", title: "新規feedback", body: "再現手順" });

    const selected = writableSnapshot();
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
        }], attachments: []
      }]
    };
    fixture.emit(selected);
    root.querySelector<HTMLButtonElement>("[data-feedback-focus=reply]")!.click();
    await Promise.resolve();
    expect(write).toHaveBeenCalledWith({ type: "reply", threadId, body: "返信本文" });

    root.querySelector<HTMLButtonElement>("[data-feedback-focus='revise:018f0f58-c3d1-7a2b-8a4f-4c09571e5002']")!.click();
    fixture.emit({ ...selected, localState: { ...selected.localState, draft: "編集本文" } });
    root.querySelector<HTMLButtonElement>("[data-feedback-focus=revise-save]")!.click();
    await Promise.resolve();
    expect(write).toHaveBeenCalledWith({
      type: "revise", threadId,
      messageId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5002",
      expectedRevisionId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5003",
      body: "編集本文"
    });
    expect(fixture.commands.filter((command) => ["submit", "reply", "revise"].includes(command.type)).map((command) => command.type))
      .toEqual(["submit", "reply", "revise"]);
  });

  it("capture完了時だけuploadをdispatchし、cancel時は保持結果を使わない", async () => {
    defineFeedbackWebComponent();
    const selected = writableSnapshot();
    selected.threads.selected = { ...selected.threads.items[0]!, messages: [] };
    const fixture = controller(selected);
    const runtime = fixture.value as FeedbackBrowserControllerPort;
    const write = vi.fn(async (input: FeedbackControllerWriteInput) => ({ type: input.type } as FeedbackControllerWriteCommand));
    runtime.createWriteCommand = write;
    runtime.getCapturedEvidence = () => null;
    runtime.dispatch = vi.fn(async (command) => {
      fixture.commands.push(command);
      if (command.type === "begin-evidence-capture") fixture.emit({ ...selected, capture: "captured" });
    });
    const element = document.createElement(feedbackElementName) as FeedbackElement;
    element.controller = runtime;
    element.open = true;
    document.body.append(element);
    const root = element.shadowRoot!;
    root.querySelector<HTMLButtonElement>("[data-feedback-focus=capture]")!.click();
    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledWith({ type: "upload-attachment", threadId });
      expect(fixture.commands.map((command) => command.type)).toEqual(["begin-evidence-capture", "upload-attachment"]);
    });

    write.mockClear();
    fixture.emit({ ...selected, capture: "capturing" });
    root.querySelector<HTMLButtonElement>("[data-feedback-focus=capture]")!.click();
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
    expect(fixture.commands[fixture.commands.length - 1]).toEqual({ type: "cancel-evidence-capture" });
  });
});

function writableSnapshot(): FeedbackControllerSnapshot {
  const value = snapshot();
  value.profile = {
    ...value.profile!,
    capabilities: {
      ...value.profile!.capabilities,
      backendOperations: ["feedback:read", "feedback:create", "feedback:reply", "feedback:revise", "feedback:attachment:upload"]
    },
    effectivePermissions: ["feedback:read", "feedback:create", "feedback:reply", "feedback:revise", "feedback:attachment:upload"]
  };
  return value;
}

describe("framework非依存Feedback plugin", () => {
  const scope = { profileId: "inventory-production", workspaceId: "OPS", resource: { kind: "record", key: "order-001" } } as const;

  it("controllerを生成、connectし、二重mountを拒否してdestroy後に再mountできる", async () => {
    const mount = document.createElement("div");
    document.body.append(mount);
    const firstController = controller();
    const first = createFeedbackPlugin({ mount, scope, createController: () => firstController.value, styleNonce: "phase4" });
    await first.ready;
    expect(firstController.commands[0]).toEqual({ type: "connect", scope });
    expect(mount.querySelector(feedbackElementName)).toBe(first.element);
    expect(() => createFeedbackPlugin({ mount, scope, createController: () => controller().value })).toThrow(/二重mount/u);
    first.destroy();
    first.destroy();
    expect(firstController.commands[firstController.commands.length - 1]).toEqual({ type: "destroy" });
    expect(mount.childNodes).toHaveLength(0);

    const second = createFeedbackPlugin({ mount, scope, createController: () => controller().value });
    await second.ready;
    expect(mount.querySelector(feedbackElementName)).toBe(second.element);
    second.destroy();
  });

  it("destroy後はconnect失敗とcommand eventをhost callbackへ渡さない", async () => {
    const mount = document.createElement("div");
    document.body.append(mount);
    let reject!: (error: unknown) => void;
    const pending = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const fixture = controller(snapshot(), async (command) => command.type === "connect" ? pending : undefined);
    const unavailable = vi.fn();
    const plugin = createFeedbackPlugin({ mount, scope, createController: () => fixture.value, onUnavailable: unavailable });
    plugin.destroy();
    reject(new Error("late connect failure"));
    await plugin.ready;
    expect(unavailable).not.toHaveBeenCalled();
  });
});
