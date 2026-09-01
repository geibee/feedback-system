import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent
} from "react";
import type {
  FeedbackBrowserControllerPort,
  FeedbackControllerCommand,
  FeedbackControllerPort,
  FeedbackControllerSnapshot,
  FeedbackControllerWriteInput
} from "@geibee/feedback-controller";

export type FeedbackOverlayProps = {
  controller: FeedbackControllerPort;
  label?: string;
  defaultOpen?: boolean;
  onCommandError?: (error: unknown) => void;
};

export type FeedbackOverlayHandle = {
  open(): void;
  close(): void;
  refresh(): Promise<void>;
  openThread(threadId: string): Promise<void>;
};

export function useFeedbackControllerSnapshot(controller: FeedbackControllerPort): FeedbackControllerSnapshot {
  return useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.getSnapshot(),
    () => controller.getSnapshot()
  );
}

/** network、storage、pollingを持たず、snapshot描画とfrozen command発行だけを行う。 */
export const FeedbackOverlay = forwardRef<FeedbackOverlayHandle, FeedbackOverlayProps>(function FeedbackOverlay(
  { controller, label = "フィードバック", defaultOpen = false, onCommandError },
  ref
) {
  const snapshot = useFeedbackControllerSnapshot(controller);
  const [open, setOpen] = useState(defaultOpen);
  const [title, setTitle] = useState("");
  const [revisionTarget, setRevisionTarget] = useState<{
    messageId: string;
    expectedRevisionId: string;
  } | null>(null);
  const reactId = useId().replace(/:/gu, "");
  const panelId = `feedback-v2-react-panel-${reactId}`;
  const titleId = `feedback-v2-react-title-${reactId}`;
  const launcherRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const dispatch = useCallback(async (command: FeedbackControllerCommand) => {
    try {
      await controller.dispatch(command);
      return true;
    } catch (error) {
      try { onCommandError?.(error); } catch { /* host callbackをrendererへ伝播させない */ }
      return false;
    }
  }, [controller, onCommandError]);

  const dispatchWrite = useCallback(async (input: FeedbackControllerWriteInput) => {
    if (!isBrowserController(controller)) {
      try { onCommandError?.(new Error("browser write compositionが接続されていません")); } catch { /* host callbackをrendererへ伝播させない */ }
      return false;
    }
    try {
      const command = await controller.createWriteCommand(input);
      await controller.dispatch(command);
      return true;
    } catch (error) {
      try { onCommandError?.(error); } catch { /* host callbackをrendererへ伝播させない */ }
      return false;
    }
  }, [controller, onCommandError]);

  const show = useCallback(() => {
    setOpen(true);
    queueMicrotask(() => closeRef.current?.focus());
  }, []);
  const hide = useCallback(() => {
    setOpen(false);
    queueMicrotask(() => launcherRef.current?.focus());
  }, []);

  useImperativeHandle(ref, () => ({
    open: show,
    close: hide,
    async refresh() { await dispatch({ type: "refresh" }); },
    async openThread(threadId) {
      show();
      await dispatch({ type: "select-thread", threadId });
    }
  }), [dispatch, hide, show]);

  const onDialogKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      hide();
    }
  };
  const connected = snapshot.lifecycle === "connected";
  const followed = new Set(snapshot.localState.followedThreadIds);
  const selected = snapshot.threads.selected;
  const permissions = new Set(snapshot.profile?.effectivePermissions ?? []);
  const browserController = isBrowserController(controller);
  const canCreate = connected && browserController && permissions.has("feedback:create");
  const canReply = connected && browserController && permissions.has("feedback:reply") && Boolean(selected);
  const canRevise = connected && browserController && permissions.has("feedback:revise") && Boolean(selected);
  const canUpload = connected && browserController && permissions.has("feedback:attachment:upload") && Boolean(selected);

  useEffect(() => setRevisionTarget(null), [selected?.threadId]);

  const captureOrCancel = async () => {
    const initial = controller.getSnapshot();
    if (initial.capture === "capturing") {
      await dispatch({ type: "cancel-evidence-capture" });
      return;
    }
    const targetThreadId = initial.threads.selected?.threadId;
    if (!targetThreadId) return;
    if (!await dispatch({ type: "begin-evidence-capture" })) return;
    const current = controller.getSnapshot();
    if (current.capture === "captured" && current.threads.selected?.threadId === targetThreadId &&
      current.profile?.effectivePermissions.includes("feedback:attachment:upload")) {
      await dispatchWrite({ type: "upload-attachment", threadId: targetThreadId });
    }
  };

  return <div className="feedback-v2-root" data-feedback-renderer="react">
    <button
      ref={launcherRef}
      type="button"
      className="feedback-v2-launcher"
      aria-expanded={open}
      aria-controls={panelId}
      onClick={() => open ? hide() : show()}
    >{label}</button>
    {open && <section
      id={panelId}
      className="feedback-v2-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-busy={snapshot.threads.refreshing || snapshot.threads.state === "loading"}
      onKeyDown={onDialogKeyDown}
    >
      <header className="feedback-v2-header">
        <h2 id={titleId}>{snapshot.profile?.displayName ?? label}</h2>
        <button ref={closeRef} type="button" className="feedback-v2-button" aria-label="閉じる" onClick={hide}>閉じる</button>
      </header>
      <p className="feedback-v2-status" role="status" aria-live="polite">{statusText(snapshot)}</p>
      {snapshot.threads.error && <p className="feedback-v2-problem" role="alert">{snapshot.threads.error.title}</p>}

      {snapshot.discovery.workspaces.length > 0 && <label className="feedback-v2-field">
        <span>ワークスペース</span>
        <select
          value={snapshot.discovery.selectedWorkspaceId ?? ""}
          disabled={!connected}
          onChange={(event) => void dispatch({ type: "select-workspace", workspaceId: event.currentTarget.value })}
        >
          <option value="" disabled>選択してください</option>
          {snapshot.discovery.workspaces.map((workspace) => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.displayName}</option>)}
        </select>
      </label>}
      {snapshot.discovery.resources.length > 0 && <label className="feedback-v2-field">
        <span>対象</span>
        <select
          value={selectedResourceIndex(snapshot)}
          disabled={!connected}
          onChange={(event) => {
            const resource = snapshot.discovery.resources[Number(event.currentTarget.value)]?.resource;
            if (resource) void dispatch({ type: "select-resource", resource });
          }}
        >
          <option value="" disabled>選択してください</option>
          {snapshot.discovery.resources.map((resource, index) => <option key={`${resource.resource.kind}:${resource.resource.key}`} value={String(index)}>{resource.displayName}</option>)}
        </select>
      </label>}

      <div className="feedback-v2-actions">
        <button type="button" className="feedback-v2-button" disabled={!connected || snapshot.threads.refreshing} onClick={() => void dispatch({ type: "refresh" })}>更新</button>
        <button type="button" className="feedback-v2-button" disabled={!connected} onClick={() => void dispatch({ type: snapshot.targetSelection === "selecting" ? "cancel-target-selection" : "begin-target-selection" })}>
          {snapshot.targetSelection === "selecting" ? "対象選択を中止" : "対象を選択"}
        </button>
        <button type="button" className="feedback-v2-button" disabled={!connected || (!canUpload && snapshot.capture !== "capturing")} onClick={() => void captureOrCancel()}>
          {snapshot.capture === "capturing" ? "撮影を中止" : "証跡を撮影"}
        </button>
      </div>

      <ul className="feedback-v2-list" aria-label="フィードバックスレッド">
        {snapshot.threads.items.map((thread) => {
          const unread = snapshot.localState.unreadCountByThread[thread.threadId] ?? 0;
          return <li key={thread.threadId}><button
            type="button"
            className="feedback-v2-thread"
            aria-current={selected?.threadId === thread.threadId}
            disabled={!connected}
            onClick={() => void dispatch({ type: "select-thread", threadId: thread.threadId })}
          >{thread.title}{unread > 0 && <span className="feedback-v2-unread" aria-label={`未読 ${unread}件`}>{unread}</span>}</button></li>;
        })}
      </ul>
      {snapshot.threads.nextCursor && <button type="button" className="feedback-v2-button" disabled={!connected} onClick={() => void dispatch({ type: "load-more" })}>続きを読み込む</button>}

      {selected && <section aria-label="選択したスレッド">
        <h3>{selected.title}</h3>
        <label><input
          type="checkbox"
          checked={followed.has(selected.threadId)}
          onChange={() => void dispatch({ type: followed.has(selected.threadId) ? "unfollow" : "follow", threadId: selected.threadId })}
        /> この端末でフォロー</label>
        <div className="feedback-v2-messages">{selected.messages.map((message) => <article className="feedback-v2-message" key={message.messageId}>
          <strong>{message.author.displayName}</strong><p>{message.body}</p>
          {canRevise && message.author.kind === "participant" && message.author.isCurrentParticipant && <button
            type="button"
            className="feedback-v2-button"
            onClick={() => {
              setRevisionTarget({
                messageId: message.messageId,
                expectedRevisionId: message.revisions[message.revisions.length - 1]?.revisionId ?? message.messageId
              });
              void dispatch({ type: "update-draft", value: message.body });
            }}
          >この投稿を編集</button>}
        </article>)}</div>
        {snapshot.profile?.externalNavigationPath && <button type="button" className="feedback-v2-button" onClick={() => void dispatch({ type: "request-navigation", threadId: selected.threadId })}>関連画面へ移動</button>}
      </section>}

      <label className="feedback-v2-field">
        <span>下書き</span>
        <textarea
          value={snapshot.localState.draft}
          maxLength={100_000}
          disabled={!connected || !(["feedback:create", "feedback:reply", "feedback:revise"] as const).some((operation) => permissions.has(operation))}
          onChange={(event) => void dispatch({ type: "update-draft", value: event.currentTarget.value })}
        />
      </label>
      {!selected && <label className="feedback-v2-field">
        <span>件名</span>
        <input value={title} maxLength={300} disabled={!canCreate} onChange={(event) => setTitle(event.currentTarget.value)} />
      </label>}
      <div className="feedback-v2-actions" aria-label="投稿操作">
        {!selected && <button
          type="button"
          className="feedback-v2-button"
          disabled={!canCreate || title.length === 0 || snapshot.localState.draft.length === 0}
          onClick={() => void dispatchWrite({ type: "submit", title, body: snapshot.localState.draft })}
        >送信</button>}
        {selected && !revisionTarget && <button
          type="button"
          className="feedback-v2-button"
          disabled={!canReply || snapshot.localState.draft.length === 0}
          onClick={() => void dispatchWrite({ type: "reply", threadId: selected.threadId, body: snapshot.localState.draft })}
        >返信</button>}
        {selected && revisionTarget && <>
          <button
            type="button"
            className="feedback-v2-button"
            disabled={!canRevise || snapshot.localState.draft.length === 0}
            onClick={() => void dispatchWrite({
              type: "revise", threadId: selected.threadId, messageId: revisionTarget.messageId,
              expectedRevisionId: revisionTarget.expectedRevisionId, body: snapshot.localState.draft
            }).then((sent) => { if (sent) setRevisionTarget(null); })}
          >変更を保存</button>
          <button type="button" className="feedback-v2-button" onClick={() => setRevisionTarget(null)}>編集を中止</button>
        </>}
      </div>
      {snapshot.pendingIntents.length > 0 && <section aria-label="確認が必要な操作">
        <h3>確認が必要な操作</h3>
        <ul className="feedback-v2-list">{snapshot.pendingIntents.map((pending) => <li key={pending.intentId}>
          <span>{"detail" in pending.recovery ? pending.recovery.detail : `${pending.operation}の結果を確認します`}</span>{" "}
          <button type="button" className="feedback-v2-button" onClick={() => void dispatch({ type: "recover-intent", intentId: pending.intentId })}>結果を確認</button>
        </li>)}</ul>
      </section>}
    </section>}
  </div>;
});

function statusText(snapshot: FeedbackControllerSnapshot): string {
  if (snapshot.lifecycle === "connecting") return "接続しています";
  if (snapshot.lifecycle === "destroyed") return "Feedbackは終了しました";
  if (snapshot.threads.refreshing) return "更新しています";
  if (snapshot.threads.state === "loading") return "読み込んでいます";
  if (snapshot.capture === "capturing") return "証跡を撮影しています";
  if (snapshot.targetSelection === "selecting") return "対象を選択してください";
  return snapshot.lifecycle === "connected" ? `${snapshot.threads.items.length}件のスレッド` : "未接続です";
}

function sameResource(
  left: FeedbackControllerSnapshot["discovery"]["selectedResource"],
  right: FeedbackControllerSnapshot["discovery"]["selectedResource"]
): boolean {
  return Boolean(left && right && left.kind === right.kind && left.key === right.key);
}

function selectedResourceIndex(snapshot: FeedbackControllerSnapshot): string {
  if (!snapshot.discovery.selectedResource) return "";
  const index = snapshot.discovery.resources.findIndex((item) => sameResource(item.resource, snapshot.discovery.selectedResource));
  return index < 0 ? "" : String(index);
}

function isBrowserController(controller: FeedbackControllerPort): controller is FeedbackBrowserControllerPort {
  const candidate = controller as Partial<FeedbackBrowserControllerPort>;
  return typeof candidate.createWriteCommand === "function" && typeof candidate.getCapturedEvidence === "function";
}
