import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import type { components } from "@feedback/contracts";
import type {
  FeedbackEvidencePayload,
  FeedbackPinPosition as CoreFeedbackPinPosition,
  FeedbackPinPositionProvider as CoreFeedbackPinPositionProvider,
  FeedbackTargetResolver as CoreFeedbackTargetResolver,
  FeedbackTargetResolverInput as CoreFeedbackTargetResolverInput
} from "@feedback/core";
import {
  feedbackElementKeyAttribute,
  feedbackExcludeAttribute,
  feedbackMapAttribute,
  feedbackMaskAttribute,
  resolveDomFeedbackTarget
} from "@feedback/react-ui";
import { createDomEvidenceProvider } from "./capture.js";
import { useFeedback } from "./index.js";

type Schemas = components["schemas"];
type Thread = Schemas["FeedbackThreadV1"];
type Message = Schemas["FeedbackMessageV1"];
type MessageVersion = Schemas["FeedbackMessageVersionV1"];
type Target = Schemas["FeedbackTargetV1"];
type Session = Schemas["FeedbackSessionV1"];
type Location = Schemas["FeedbackLocationV1"];
type UnreadReplySummary = Schemas["FeedbackUnreadReplySummary"];

type OverlayMode = "idle" | "picking" | "capturing" | "composing";

type PickedTarget = {
  target: Target;
  evidence: FeedbackEvidencePayload | null;
  captureRequested: boolean;
  captureError: string | null;
};

type ContextMenuState = {
  clientX: number;
  clientY: number;
  target: Target;
};

const reactionDefinitions = [
  ["thumbs_up", "👍"],
  ["check", "✅"],
  ["eyes", "👀"],
  ["question", "❓"]
] as const;

function reactionLabel(reaction: Schemas["FeedbackReactionKey"]): string {
  switch (reaction) {
    case "thumbs_up": return "賛成";
    case "check": return "確認済み";
    case "eyes": return "確認中";
    case "question": return "質問";
  }
}

export { feedbackElementKeyAttribute, feedbackExcludeAttribute, feedbackMapAttribute, feedbackMaskAttribute } from "@feedback/react-ui";

export type FeedbackOverlayProps = {
  deepLinkThreadId?: string | null;
  className?: string;
  /** MapLibreなどhost固有領域のpointer座標を専用targetへ変換する。null時はDOM/screen targetへ戻す。 */
  targetResolver?: FeedbackTargetResolver;
  /** 地図targetなどをviewport上のpin座標へ投影し、表示位置の変更を通知する。 */
  pinPositionProvider?: FeedbackPinPositionProvider;
  /** レビュー案内の既読状態を保存するlocalStorage key。 */
  reviewIntroductionStorageKey?: string;
  /** 受付中レビューがない場合に表示する管理画面URL。 */
  reviewManagementUrl?: string;
};

export type FeedbackTargetResolverInput = CoreFeedbackTargetResolverInput<Element>;
export type FeedbackTargetResolver = CoreFeedbackTargetResolver<Element>;
export type FeedbackPinPosition = CoreFeedbackPinPosition;
export type FeedbackPinPositionProvider = CoreFeedbackPinPositionProvider;

/** v1 transport だけを使う汎用 Overlay。ホストの router/API/TanStack Query へ依存しない。 */
export function FeedbackOverlay({
  deepLinkThreadId,
  className,
  targetResolver,
  pinPositionProvider,
  reviewIntroductionStorageKey,
  reviewManagementUrl
}: FeedbackOverlayProps) {
  const feedback = useFeedback();
  const session = feedback.reviewContext?.session ?? null;
  const [threads, setThreads] = useState<Thread[]>([]);
  const [active, setActive] = useState<{ thread: Thread; etag: string | null } | null>(null);
  const [mode, setMode] = useState<OverlayMode>("idle");
  const [picked, setPicked] = useState<PickedTarget | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [threadListOpen, setThreadListOpen] = useState(false);
  const [activePanelSide, setActivePanelSide] = useState<"left" | "right">("right");
  const [error, setError] = useState<string | null>(null);
  const [unreadReplies, setUnreadReplies] = useState<UnreadReplySummary>({ totalCount: 0, threads: [] });
  const captureGeneration = useRef(0);
  const threadRequestGeneration = useRef(0);
  const permissions = feedback.reviewContext?.permissions ?? [];
  const canRead = permissions.includes("feedback.read");
  const canComment = permissions.includes("feedback.comment");
  const posting = feedback.reviewContext?.posting ?? "deny";
  const runtimeContextKey = feedback.hostContext && feedback.location
    ? JSON.stringify([
      feedback.hostContext.applicationKey,
      feedback.hostContext.environmentKey,
      feedback.hostContext.externalWorkspaceKey,
      feedback.location.pageKey,
      feedback.location.routeTemplate,
      feedback.location.pathParameters,
      feedback.location.queryParameters ?? {}
    ])
    : null;
  const unreadByThread = useMemo(() => new Map(
    unreadReplies.threads.map((item) => [item.threadId, item.count])
  ), [unreadReplies.threads]);

  const refreshUnreadReplies = useCallback(async () => {
    if (!canRead || !feedback.hostContext) {
      setUnreadReplies({ totalCount: 0, threads: [] });
      return;
    }
    const params = new URLSearchParams({
      applicationKey: feedback.hostContext.applicationKey,
      environmentKey: feedback.hostContext.environmentKey,
      externalWorkspaceKey: feedback.hostContext.externalWorkspaceKey
    });
    try {
      const resource = await feedback.transport.request<UnreadReplySummary>(`/me/unread-replies?${params}`);
      setUnreadReplies(resource.value);
    } catch {
      // 未読数の一時的な取得失敗で、投稿・閲覧機能全体を利用不能にしない。
    }
  }, [canRead, feedback.hostContext, feedback.transport]);

  const refreshThreads = useCallback(async () => {
    const generation = ++threadRequestGeneration.current;
    if (!session || !canRead) {
      setThreads([]);
      return;
    }
    try {
      const basePath = `/sessions/${encodeURIComponent(session.id)}/threads`;
      const items: Thread[] = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const path: string = cursor ? `${basePath}?cursor=${encodeURIComponent(cursor)}` : basePath;
        const page: { value: Schemas["FeedbackThreadPage"]; etag: string | null } =
          await feedback.transport.request<Schemas["FeedbackThreadPage"]>(path);
        items.push(...page.value.items);
        cursor = page.value.nextCursor ?? null;
        if (cursor && cursors.has(cursor)) throw new Error("フィードバック一覧のcursorが循環しています");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (generation === threadRequestGeneration.current) {
        setThreads(items);
        setError(null);
      }
    } catch (nextError) {
      if (generation === threadRequestGeneration.current) setError(messageOf(nextError));
    }
  }, [canRead, feedback.transport, session]);

  useEffect(() => {
    captureGeneration.current += 1;
    threadRequestGeneration.current += 1;
    setThreads([]);
    setActive(null);
    setMode("idle");
    setPicked(null);
    setContextMenu(null);
    setThreadListOpen(false);
    setActivePanelSide("right");
  }, [runtimeContextKey, session?.id]);
  useEffect(() => { void refreshThreads(); }, [refreshThreads]);
  useEffect(() => {
    if (!canRead || typeof document === "undefined") return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshUnreadReplies();
    };
    refreshWhenVisible();
    const intervalId = window.setInterval(refreshWhenVisible, 30_000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [canRead, refreshUnreadReplies]);

  const reset = useCallback(() => {
    captureGeneration.current += 1;
    setMode("idle");
    setPicked(null);
    setContextMenu(null);
  }, []);

  const resolvePointerTarget = useCallback((
    element: Element | null,
    event: MouseEvent,
    action: FeedbackTargetResolverInput["action"]
  ): Target => {
    const fallback = targetAtEvent(element, event);
    if (!targetResolver) return fallback;
    try {
      return targetResolver({
        action,
        element,
        clientX: event.clientX,
        clientY: event.clientY
      }) ?? fallback;
    } catch (nextError) {
      setError(messageOf(nextError));
      return fallback;
    }
  }, [targetResolver]);

  const startPicking = useCallback(() => {
    captureGeneration.current += 1;
    setActive(null);
    setThreadListOpen(false);
    setPicked(null);
    setContextMenu(null);
    setMode("picking");
  }, []);

  const selectTarget = useCallback(async (target: Target) => {
    const generation = ++captureGeneration.current;
    setContextMenu(null);
    const captureRequested = feedback.features.evidenceCapture !== false &&
      feedback.reviewContext?.evidencePolicy.enabled !== false;
    if (!captureRequested || !feedback.hostContext || !feedback.location) {
      setPicked({ target, evidence: null, captureRequested: false, captureError: null });
      setMode("composing");
      return;
    }
    setMode("capturing");
    let evidence: FeedbackEvidencePayload | null = null;
    let captureError: string | null = null;
    try {
      evidence = await (feedback.adapter.captureEvidence ?? createDomEvidenceProvider({
        maxBytes: feedback.reviewContext?.evidencePolicy.maxBytes
      }))({
        context: feedback.hostContext,
        location: feedback.location,
        target,
        excludeSelector: `[${feedbackExcludeAttribute}], [data-feedback-overlay]`,
        maskSelector: `[${feedbackMaskAttribute}]`
      });
      if (!evidence) captureError = "スクリーンショットを生成できませんでした";
    } catch (nextError) {
      captureError = messageOf(nextError);
    }
    if (generation !== captureGeneration.current) return;
    if (captureError) feedback.telemetry?.increment("capture_failure", feedback.hostContext);
    setPicked({ target, evidence, captureRequested: true, captureError });
    setMode("composing");
  }, [feedback]);

  const openThread = useCallback(async (threadId: string, navigate: boolean) => {
    if (!canRead) return;
    try {
      const resource = await feedback.transport.request<Thread>(`/threads/${encodeURIComponent(threadId)}`);
      if (navigate) await feedback.adapter.navigate(resource.value.location, resource.value.id);
      setThreadListOpen(false);
      reset();
      setActive({ thread: resource.value, etag: resource.etag });
      setError(null);
      const latestMessage = resource.value.messages[resource.value.messages.length - 1];
      if (latestMessage) {
        try {
          await feedback.transport.request(`/threads/${encodeURIComponent(threadId)}/read-state`, {
            method: "PUT",
            body: { readThroughMessageId: latestMessage.id }
          });
          setUnreadReplies((current) => {
            const read = current.threads.find((item) => item.threadId === threadId)?.count ?? 0;
            return {
              totalCount: Math.max(0, current.totalCount - read),
              threads: current.threads.filter((item) => item.threadId !== threadId)
            };
          });
        } catch {
          // 既読更新に失敗してもスレッドの閲覧は継続する。
        }
      }
    } catch (nextError) {
      setError(messageOf(nextError));
    }
  }, [canRead, feedback.adapter, feedback.transport, reset]);

  useEffect(() => {
    if (deepLinkThreadId) void openThread(deepLinkThreadId, true);
  }, [deepLinkThreadId, openThread]);

  useEffect(() => {
    if (mode !== "picking" || !feedback.location || !session || !canComment || posting === "deny") return;
    const handleClick = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target : null;
      if (element?.closest("[data-feedback-overlay]")) return;
      if (element?.closest(`[${feedbackExcludeAttribute}]`)) return;
      event.preventDefault();
      event.stopPropagation();
      void selectTarget(resolvePointerTarget(element, event, "pick"));
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") reset();
    };
    document.addEventListener("click", handleClick, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [canComment, feedback.location, mode, posting, reset, resolvePointerTarget, selectTarget, session]);

  useEffect(() => {
    if (
      feedback.features.contextMenu !== true ||
      mode !== "idle" ||
      !feedback.location ||
      !session ||
      !canComment ||
      posting === "deny"
    ) return;
    const handleContextMenu = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target : null;
      if (element?.closest("[data-feedback-overlay]")) return;
      if (element?.closest(`[${feedbackExcludeAttribute}]`)) return;
      event.preventDefault();
      setActive(null);
      setThreadListOpen(false);
      setContextMenu({
        clientX: event.clientX,
        clientY: event.clientY,
        target: resolvePointerTarget(element, event, "context-menu")
      });
    };
    document.addEventListener("contextmenu", handleContextMenu, true);
    return () => document.removeEventListener("contextmenu", handleContextMenu, true);
  }, [canComment, feedback.features.contextMenu, feedback.location, mode, posting, resolvePointerTarget, session]);

  if (feedback.state !== "ready" || !feedback.location) return null;
  const visibleThreads = threads.filter((thread) => feedbackThreadMatchesLocation(thread, feedback.location!));
  const overlayClassName = `feedback-overlay-root${className ? ` ${className}` : ""}`;
  const content = (
    <div className={overlayClassName} data-feedback-overlay="">
      {!session ? (
        reviewManagementUrl ? <ReviewInactiveStatus managementUrl={reviewManagementUrl} /> : null
      ) : (
        <>
          <ReviewIntroduction
            session={session}
            location={feedback.location}
            scope={feedback.reviewContext?.scope ?? "unregistered"}
            visible={mode === "idle" && !active && !threadListOpen && !contextMenu}
            autoOpen={feedback.features.autoIntroduction === true}
            storageKey={reviewIntroductionStorageKey}
          />
          {canRead ? (
            <PinLayer
              threads={visibleThreads}
              session={session}
              activeThreadId={active?.thread.id ?? null}
              positionProvider={pinPositionProvider}
              onActiveSideChange={setActivePanelSide}
              onOpen={(id, position) => {
                setActivePanelSide(panelSideOpposite(position));
                void openThread(id, false);
              }}
            />
          ) : null}
          {mode === "idle" && !active && !threadListOpen && !contextMenu ? (
            <>
              {canComment && posting !== "deny" ? (
                <button type="button" className="feedback-launcher" onClick={startPicking}>
                  <span aria-hidden="true">＋</span>
                  {feedback.messages.launcher}
                </button>
              ) : null}
              {canRead ? (
                <button type="button" className="feedback-thread-list-launcher" onClick={() => setThreadListOpen(true)}>
                  {feedback.messages.browseThreads} <span className="feedback-thread-count">{threads.length}</span>
                  {unreadReplies.totalCount > 0 ? <span className="feedback-unread-badge" aria-label={`未読の返信 ${unreadReplies.totalCount}件`}>{unreadReplies.totalCount}</span> : null}
                </button>
              ) : null}
            </>
          ) : null}
          {canComment && posting === "deny" ? (
            <p className="feedback-posting-notice" role="status">{feedback.messages.postingDenied}</p>
          ) : null}
          {mode === "picking" || mode === "capturing" ? (
            <div className="feedback-picking-bar" role="status" aria-live="polite">
              <span>{mode === "capturing" ? feedback.messages.capturing : feedback.messages.selectTarget}</span>
              <button type="button" className="feedback-button-secondary" onClick={reset}>
                {feedback.messages.cancel}
              </button>
            </div>
          ) : null}
          {mode === "composing" && picked ? (
            <Composer
              picked={picked}
              onClose={reset}
              onBrowse={() => {
                reset();
                setThreadListOpen(true);
              }}
              onCreated={(thread) => {
                setThreads((current) => [...current.filter((item) => item.id !== thread.id), thread]);
                reset();
              }}
            />
          ) : null}
          {threadListOpen && !active ? (
            <ThreadList
              threads={threads}
              session={session}
              unreadByThread={unreadByThread}
              onClose={() => setThreadListOpen(false)}
              onOpen={(id) => void openThread(id, true)}
            />
          ) : null}
          {active ? (
            <ThreadDrawer
              resource={active}
              session={session}
              side={activePanelSide}
              onChange={(next) => {
                setActive(next);
                setThreads((current) => current.map((item) => item.id === next.thread.id ? next.thread : item));
              }}
              onClose={() => setActive(null)}
            />
          ) : null}
          {contextMenu ? (
            <FeedbackContextMenu
              value={contextMenu}
              onClose={() => setContextMenu(null)}
              onSelect={() => void selectTarget(contextMenu.target)}
            />
          ) : null}
        </>
      )}
      {error ? <p className="feedback-toast feedback-error" role="alert">{error}</p> : null}
    </div>
  );
  const portalTarget = feedback.portalTarget ?? (typeof document === "undefined" ? null : document.body);
  return portalTarget ? createPortal(content, portalTarget) : content;
}

export function feedbackThreadMatchesLocation(
  thread: Pick<Thread, "location">,
  location: Location
): boolean {
  return thread.location.pageKey === location.pageKey &&
    thread.location.routeTemplate === location.routeTemplate &&
    equalParameters(thread.location.pathParameters, location.pathParameters) &&
    equalParameters(thread.location.queryParameters ?? {}, location.queryParameters ?? {});
}

function equalParameters(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

function Composer({
  picked,
  onClose,
  onBrowse,
  onCreated
}: {
  picked: PickedTarget;
  onClose(): void;
  onBrowse(): void;
  onCreated(thread: Thread): void;
}) {
  const feedback = useFeedback();
  const session = feedback.reviewContext?.session;
  const perspectives = useMemo(
    () => activePerspectivesForLocation(session, feedback.location),
    [feedback.location, session]
  );
  const [body, setBody] = useState("");
  const [perspective, setPerspective] = useState(perspectives[0]?.code ?? "");
  const [participantName, setParticipantName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRequest = useRef<{ idempotencyKey: string; body: Record<string, unknown> } | null>(null);
  const panelRef = useDismissiblePanel<HTMLFormElement>(onClose);
  const previewUrl = useEvidencePreview(picked.evidence);

  useEffect(() => {
    void Promise.resolve(feedback.adapter.getParticipantName?.() ?? null).then((value) => setParticipantName(value ?? ""));
  }, [feedback.adapter]);
  useEffect(() => {
    if (!perspectives.some((item) => item.code === perspective)) setPerspective(perspectives[0]?.code ?? "");
  }, [perspective, perspectives]);
  useEffect(() => { pendingRequest.current = null; }, [body, participantName, perspective, picked]);

  if (!session || !feedback.location || !feedback.hostContext) return null;
  const hostContext = feedback.hostContext;
  const location = feedback.location;
  const prompt = shouldPromptParticipant(feedback);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim() || !perspective || (prompt && !participantName.trim())) return;
    setSubmitting(true);
    setError(null);
    try {
      if (!pendingRequest.current) {
        pendingRequest.current = {
          idempotencyKey: idempotencyKey(),
          body: {
            location,
            target: picked.target,
            perspectiveCode: perspective,
            body: body.trim(),
            participantName: participantName.trim() || null,
            ...(picked.evidence ? { evidence: evidenceBody(picked.evidence) } : {})
          }
        };
      }
      const pending = pendingRequest.current;
      const resource = await feedback.transport.request<Thread>(
        `/sessions/${encodeURIComponent(session.id)}/threads`,
        {
          method: "POST",
          idempotencyKey: pending.idempotencyKey,
          body: pending.body
        }
      );
      pendingRequest.current = null;
      feedback.telemetry?.increment("post_success", hostContext);
      if (prompt) await feedback.adapter.setParticipantName?.(participantName.trim() || null);
      onCreated(resource.value);
    } catch (nextError) {
      setError(messageOf(nextError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      ref={panelRef}
      className="feedback-panel feedback-composer"
      role="dialog"
      aria-label="フィードバックの投稿"
      onSubmit={(event) => void submit(event)}
    >
      <PanelHeader title={feedback.messages.launcher} closeLabel="投稿画面を閉じる" onClose={onClose} />
      <p className="feedback-target-summary">
        {feedback.messages.target}: <code>{describeTarget(picked.target)}</code>
      </p>
      <button type="button" className="feedback-text-button feedback-browse-threads" onClick={onBrowse}>
        {feedback.messages.browseThreads}
      </button>
      {picked.captureRequested ? (
        picked.evidence ? (
          <div className="feedback-evidence">
            <p>投稿時点の画面を証跡として保存します（{picked.evidence.viewportWidth}×{picked.evidence.viewportHeight}）</p>
            {previewUrl ? <img src={previewUrl} alt="証跡プレビュー" /> : null}
          </div>
        ) : (
          <p className="feedback-error" role="alert">
            証跡の取得に失敗しました（{picked.captureError ?? "原因不明"}）。コメントのみ投稿します。
          </p>
        )
      ) : (
        <p className="feedback-note">この環境ではスクリーンショットを保存しません。</p>
      )}
      {feedback.reviewContext?.posting === "warn" ? (
        <p className="feedback-warning" role="status">{feedback.messages.postingWarning}</p>
      ) : null}
      {error ? <p className="feedback-error" role="alert">{error}</p> : null}
      <fieldset className="feedback-perspectives">
        <legend>{feedback.messages.reviewPerspective}</legend>
        {perspectives.map((item) => (
          <label key={item.code}>
            <input
              type="radio"
              name="feedback-perspective"
              value={item.code}
              checked={perspective === item.code}
              onChange={() => setPerspective(item.code)}
            />
            <span><strong>{item.label}</strong>{item.guidance ? <small>{item.guidance}</small> : null}</span>
          </label>
        ))}
        {perspectives.length === 0 ? <p className="feedback-note">選択できるレビュー観点がありません。</p> : null}
      </fieldset>
      {prompt ? (
        <label className="feedback-field">
          {feedback.messages.participantName}
          <input
            value={participantName}
            type="text"
            autoComplete="name"
            maxLength={100}
            required
            placeholder="例: 山田 太郎"
            onChange={(event) => setParticipantName(event.target.value)}
          />
          <span className="feedback-field-help">入力した名前はホストが許可した保存先へ保存され、次回から自動入力されます。</span>
        </label>
      ) : null}
      <label className="feedback-field">
        {feedback.messages.comment}
        <textarea
          rows={5}
          value={body}
          placeholder="気づいた点をご記入ください"
          onChange={(event) => setBody(event.target.value)}
        />
      </label>
      <div className="feedback-button-row">
        <button type="button" className="feedback-button-secondary" onClick={onClose}>{feedback.messages.cancel}</button>
        <button
          type="submit"
          className="feedback-button-primary"
          disabled={!body.trim() || !perspective || (prompt && !participantName.trim()) || submitting}
        >
          {submitting ? "投稿中…" : feedback.messages.submit}
        </button>
      </div>
    </form>
  );
}

function ThreadList({
  threads,
  session,
  unreadByThread,
  onClose,
  onOpen
}: {
  threads: Thread[];
  session: Session;
  unreadByThread: ReadonlyMap<string, number>;
  onClose(): void;
  onOpen(threadId: string): void;
}) {
  const feedback = useFeedback();
  const panelRef = useDismissiblePanel<HTMLElement>(onClose);
  const groups = useMemo(() => groupThreadsByScreen(threads), [threads]);
  return (
    <aside ref={panelRef} className="feedback-panel feedback-thread-list" role="dialog" aria-label={feedback.messages.browseThreads}>
      <PanelHeader title={feedback.messages.browseThreads} closeLabel="一覧を閉じる" onClose={onClose} />
      <p className="feedback-note">投稿を選ぶと対象画面へ移動し、そのフィードバックを開きます。</p>
      {groups.length > 0 ? (
        <div className="feedback-thread-groups">
          {groups.map((group) => (
            <section key={group.key} className="feedback-thread-group">
              <header><h3>{group.label}</h3><span>{group.threads.length}件</span></header>
              <ol>
                {group.threads.map((thread) => (
                  <li key={thread.id}>
                    <button type="button" onClick={() => onOpen(thread.id)}>
                      <span>
                        <strong>#{thread.displayNumber} {perspectiveLabel(session, thread.perspectiveCode)}</strong>
                        <small>{thread.status === "resolved" ? "解決済み" : "未解決"}</small>
                        {(unreadByThread.get(thread.id) ?? 0) > 0 ? <span className="feedback-unread-badge">未読 {unreadByThread.get(thread.id)}</span> : null}
                      </span>
                      <p>{lastMessageBody(thread)}</p>
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      ) : <p className="feedback-note">{feedback.messages.noThreads}</p>}
    </aside>
  );
}

function groupThreadsByScreen(threads: Thread[]): Array<{ key: string; label: string; threads: Thread[] }> {
  const groups = new Map<string, { key: string; label: string; threads: Thread[] }>();
  for (const thread of threads) {
    const key = `${thread.location.pageKey}:${thread.location.routeTemplate}`;
    const label = thread.location.pageKey;
    const group = groups.get(key) ?? { key, label, threads: [] };
    group.threads.push(thread);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function ThreadDrawer({
  resource,
  session,
  side,
  onChange,
  onClose
}: {
  resource: { thread: Thread; etag: string | null };
  session: Session;
  side: "left" | "right";
  onChange(value: { thread: Thread; etag: string | null }): void;
  onClose(): void;
}) {
  const feedback = useFeedback();
  const panelRef = useDismissiblePanel<HTMLElement>(onClose);
  const [reply, setReply] = useState("");
  const [participantName, setParticipantName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evidencePreview, setEvidencePreview] = useState<{ threadId: string; url: string } | null>(null);
  const evidenceUrlRef = useRef<string | null>(null);
  const evidenceRequestGeneration = useRef(0);
  const thread = resource.thread;
  const permissions = feedback.reviewContext?.permissions ?? [];
  const canComment = permissions.includes("feedback.comment");
  const canManage = permissions.includes("feedback.manage") || permissions.includes("feedback.admin");
  const prompt = shouldPromptParticipant(feedback);

  useEffect(() => {
    void Promise.resolve(feedback.adapter.getParticipantName?.() ?? null).then((value) => setParticipantName(value ?? ""));
  }, [feedback.adapter]);
  useEffect(() => {
    evidenceRequestGeneration.current += 1;
    const previousUrl = evidenceUrlRef.current;
    evidenceUrlRef.current = null;
    setEvidencePreview(null);
    setError(null);
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    return () => {
      evidenceRequestGeneration.current += 1;
      const currentUrl = evidenceUrlRef.current;
      evidenceUrlRef.current = null;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [thread.id]);

  const refresh = async () => {
    const next = await feedback.transport.request<Thread>(`/threads/${encodeURIComponent(thread.id)}`);
    onChange({ thread: next.value, etag: next.etag });
  };
  const postReply = async (event: FormEvent) => {
    event.preventDefault();
    if (!reply.trim() || (prompt && !participantName.trim())) return;
    setSubmitting(true);
    setError(null);
    try {
      await feedback.transport.request<Message>(`/threads/${encodeURIComponent(thread.id)}/messages`, {
        method: "POST",
        idempotencyKey: idempotencyKey(),
        body: { body: reply.trim(), participantName: participantName.trim() || null }
      });
      if (prompt) await feedback.adapter.setParticipantName?.(participantName.trim() || null);
      setReply("");
      await refresh();
    } catch (nextError) {
      setError(messageOf(nextError));
    } finally {
      setSubmitting(false);
    }
  };
  const toggleStatus = async () => {
    setUpdatingStatus(true);
    setError(null);
    try {
      const next = await feedback.transport.request<Thread>(`/threads/${encodeURIComponent(thread.id)}/status`, {
        method: "PATCH",
        ifMatch: resource.etag ?? versionEtag(thread.version),
        body: { status: thread.status === "open" ? "resolved" : "open" }
      });
      onChange({ thread: next.value, etag: next.etag });
    } catch (nextError) {
      setError(messageOf(nextError));
    } finally {
      setUpdatingStatus(false);
    }
  };
  const showEvidence = async () => {
    const generation = ++evidenceRequestGeneration.current;
    const previousUrl = evidenceUrlRef.current;
    evidenceUrlRef.current = null;
    setEvidencePreview(null);
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    setError(null);
    try {
      const evidence = await feedback.transport.requestBinary(`/threads/${encodeURIComponent(thread.id)}/evidence`);
      if (generation !== evidenceRequestGeneration.current) return;
      const nextUrl = URL.createObjectURL(new Blob([evidence.bytes.slice().buffer as ArrayBuffer], { type: evidence.contentType }));
      if (generation !== evidenceRequestGeneration.current) {
        URL.revokeObjectURL(nextUrl);
        return;
      }
      evidenceUrlRef.current = nextUrl;
      setEvidencePreview({ threadId: thread.id, url: nextUrl });
    } catch (nextError) {
      if (generation === evidenceRequestGeneration.current) setError(messageOf(nextError));
    }
  };
  return (
    <aside ref={panelRef} className={`feedback-panel feedback-thread-drawer is-${side}`} role="dialog" aria-label="フィードバックスレッド">
      <PanelHeader title={`#${thread.displayNumber} ${perspectiveLabel(session, thread.perspectiveCode)}`} closeLabel="スレッドを閉じる" onClose={onClose} />
      <div className="feedback-thread-meta">
        <span className={`feedback-thread-status${thread.status === "resolved" ? " is-resolved" : ""}`}>
          {thread.status === "resolved" ? "解決済み" : "未解決"}
        </span>
        <span>#{thread.displayNumber}</span>
        <time dateTime={thread.createdAt}>{formatTimestamp(thread.createdAt)}</time>
      </div>
      {error ? <p className="feedback-error" role="alert">{error}</p> : null}
      <ol className="feedback-message-list" aria-label="メッセージ一覧">
        {thread.messages.map((message) => (
          <MessageItem message={message} key={message.id} onUpdated={() => void refresh()} />
        ))}
      </ol>
      {thread.status === "open" && canComment ? (
        <form className="feedback-reply-form" onSubmit={(event) => void postReply(event)}>
          {prompt ? (
            <label>
              {feedback.messages.participantName}
              <input
                type="text"
                autoComplete="name"
                maxLength={100}
                required
                value={participantName}
                placeholder="例: 山田 太郎"
                onChange={(event) => setParticipantName(event.target.value)}
              />
              <span className="feedback-field-help">入力した名前はホストが許可した保存先へ保存されます。</span>
            </label>
          ) : null}
          <label>
            {feedback.messages.comment}
            <textarea
              rows={4}
              value={reply}
              placeholder="確認結果や追加情報をご記入ください"
              onChange={(event) => setReply(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="feedback-button-primary"
            disabled={!reply.trim() || (prompt && !participantName.trim()) || submitting}
          >
            {submitting ? "返信中…" : feedback.messages.reply}
          </button>
        </form>
      ) : thread.status === "resolved" ? (
        <p className="feedback-note">このスレッドは解決済みです。返信する場合は先に再開してください。</p>
      ) : null}
      <div className="feedback-actions">
        {canManage ? (
          <button
            type="button"
            className="feedback-button-secondary feedback-status-button"
            disabled={updatingStatus}
            onClick={() => void toggleStatus()}
          >
            {updatingStatus ? "更新中…" : thread.status === "open" ? feedback.messages.resolve : feedback.messages.reopen}
          </button>
        ) : null}
        {thread.evidenceAvailable ? (
          <button type="button" className="feedback-button-secondary" onClick={() => void showEvidence()}>
            {feedback.messages.evidence}
          </button>
        ) : null}
      </div>
      {evidencePreview?.threadId === thread.id
        ? <img className="feedback-evidence-preview" src={evidencePreview.url} alt={feedback.messages.evidence} />
        : null}
    </aside>
  );
}

function MessageItem({ message, onUpdated }: { message: Message; onUpdated(): void }) {
  const feedback = useFeedback();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(message.body);
  const [versions, setVersions] = useState<MessageVersion[] | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reactionBusy, setReactionBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [principalId, setPrincipalId] = useState<string | null>(null);
  const permissions = feedback.reviewContext?.permissions ?? [];
  const canManage = permissions.includes("feedback.manage") || permissions.includes("feedback.admin");
  const canReact = permissions.includes("feedback.comment");
  const canEdit = canManage || principalId === message.author.principalId;
  useEffect(() => {
    let mounted = true;
    void feedback.adapter.getIdentity?.().then((identity) => {
      if (mounted) setPrincipalId(identity?.principalId ?? null);
    });
    return () => { mounted = false; };
  }, [feedback.adapter]);
  useEffect(() => { if (!editing) setBody(message.body); }, [editing, message.body]);
  const save = async () => {
    if (!body.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await feedback.transport.request<Message>(`/messages/${encodeURIComponent(message.id)}`, {
        method: "PATCH",
        ifMatch: versionEtag(message.version),
        body: { body: body.trim(), participantName: message.author.participantName ?? null }
      });
      setEditing(false);
      onUpdated();
    } catch (nextError) {
      setError(messageOf(nextError));
    } finally {
      setSaving(false);
    }
  };
  const toggleHistory = async () => {
    if (versions) {
      setVersions(null);
      return;
    }
    setLoadingHistory(true);
    setError(null);
    try {
      setVersions((await feedback.transport.request<MessageVersion[]>(
        `/messages/${encodeURIComponent(message.id)}/versions`
      )).value);
    } catch (nextError) {
      setError(messageOf(nextError));
    } finally {
      setLoadingHistory(false);
    }
  };
  const toggleReaction = async (reaction: Schemas["FeedbackReactionKey"], reactedByMe: boolean) => {
    setReactionBusy(reaction);
    setError(null);
    try {
      await feedback.transport.request<Message>(`/messages/${encodeURIComponent(message.id)}/reactions/${reaction}`, {
        method: reactedByMe ? "DELETE" : "PUT"
      });
      onUpdated();
    } catch (nextError) {
      setError(messageOf(nextError));
    } finally {
      setReactionBusy(null);
    }
  };
  return (
    <li>
      <div className="feedback-message-heading">
        <strong>{participantLabel(message.author)}</strong>
        <time dateTime={message.createdAt}>{formatTimestamp(message.createdAt)}</time>
      </div>
      {editing ? (
        <div className="feedback-message-editor">
          <label>
            コメントを編集
            <textarea rows={4} value={body} onChange={(event) => setBody(event.target.value)} />
          </label>
          <div className="feedback-button-row">
            <button type="button" className="feedback-button-secondary" onClick={() => setEditing(false)}>
              {feedback.messages.cancel}
            </button>
            <button type="button" className="feedback-button-primary" disabled={!body.trim() || saving} onClick={() => void save()}>
              {saving ? "保存中…" : feedback.messages.save}
            </button>
          </div>
        </div>
      ) : <p>{message.body}</p>}
      {canReact ? <div className="feedback-reactions" aria-label="コメントへのリアクション">
        {reactionDefinitions.map(([reaction, emoji]) => {
          const summary = message.reactions?.find((item) => item.reaction === reaction);
          return <button
            key={reaction}
            type="button"
            className={summary?.reactedByMe ? "is-selected" : ""}
            aria-label={`${emoji} ${reactionLabel(reaction)}${summary ? ` ${summary.count}件` : ""}`}
            aria-pressed={summary?.reactedByMe ?? false}
            disabled={reactionBusy === reaction}
            onClick={() => void toggleReaction(reaction, summary?.reactedByMe ?? false)}
          >{emoji}{summary ? <span>{summary.count}</span> : null}</button>;
        })}
      </div> : null}
      {error ? <p className="feedback-error" role="alert">{error}</p> : null}
      <div className="feedback-message-actions">
        {message.editedAt ? (
          <button type="button" className="feedback-text-button" onClick={() => void toggleHistory()}>
            {loadingHistory ? "読込中…" : feedback.messages.history}
          </button>
        ) : null}
        {canEdit && !editing ? (
          <button type="button" className="feedback-text-button" onClick={() => setEditing(true)}>{feedback.messages.edit}</button>
        ) : null}
      </div>
      {versions ? (
        <div className="feedback-message-history" role="region" aria-label="コメントの編集履歴">
          {versions.map((version) => (
            <article key={version.version}>
              <div>
                <strong>版 {version.version}</strong>
                {version.current ? <span>現在</span> : null}
                <span>{participantLabel(version.author)}</span>
                <time dateTime={version.createdAt}>{formatTimestamp(version.createdAt)}</time>
              </div>
              <p>{version.body}</p>
            </article>
          ))}
        </div>
      ) : null}
    </li>
  );
}

function PinLayer({
  threads,
  session,
  activeThreadId,
  positionProvider,
  onActiveSideChange,
  onOpen
}: {
  threads: Thread[];
  session: Session;
  activeThreadId: string | null;
  positionProvider?: FeedbackPinPositionProvider;
  onActiveSideChange(side: "left" | "right"): void;
  onOpen(id: string, position: FeedbackPinPosition): void;
}) {
  const [layoutVersion, setLayoutVersion] = useState(0);
  useEffect(() => {
    const refresh = () => setLayoutVersion((current) => current + 1);
    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", refresh, true);
    const unsubscribePosition = positionProvider?.subscribe(refresh);
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(refresh);
    if (document.body) observer?.observe(document.body, { childList: true, subtree: true });
    return () => {
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refresh, true);
      unsubscribePosition?.();
      observer?.disconnect();
    };
  }, [positionProvider]);
  const pins = useMemo(() => threads.flatMap((thread) => {
    const position = pinPosition(thread.target, positionProvider);
    return position ? [{ thread, ...position }] : [];
    // layoutVersion triggers DOM geometry reads after host layout changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [layoutVersion, positionProvider, threads]);
  useEffect(() => {
    const activePin = pins.find(({ thread }) => thread.id === activeThreadId);
    if (activePin) onActiveSideChange(panelSideOpposite(activePin));
  }, [activeThreadId, onActiveSideChange, pins]);
  if (pins.length === 0) return null;
  return (
    <svg className="feedback-screen-pins" aria-label="フィードバックのピン">
      {pins.map(({ thread, x, y }) => (
        <foreignObject
          x={x - 4}
          y={y - 24}
          width="34"
          height="34"
          className="feedback-pin-host"
          key={thread.id}
        >
          <button
            type="button"
            className={`feedback-pin${thread.status === "resolved" ? " is-resolved" : ""}${thread.id === activeThreadId ? " is-active" : ""}`}
            aria-label={`#${thread.displayNumber}`}
            aria-pressed={thread.id === activeThreadId}
            title={threadLabel(thread, session)}
            onClick={() => onOpen(thread.id, { x, y })}
          >
            <span>{thread.displayNumber}</span>
          </button>
        </foreignObject>
      ))}
    </svg>
  );
}

function pinPosition(
  target: Target,
  provider?: FeedbackPinPositionProvider
): FeedbackPinPosition | null {
  if (target.kind === "screen-position") {
    return {
      x: target.relativeX * document.documentElement.clientWidth,
      y: target.relativeY * document.documentElement.clientHeight
    };
  }
  if (target.kind === "map-feature" || target.kind === "map-position") {
    return provider?.getPosition(target) ?? null;
  }
  if (target.kind !== "ui-element") return null;
  const element = findFeedbackElement(target.elementKey);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left + target.relativeX * Math.max(rect.width, 1),
    y: rect.top + target.relativeY * Math.max(rect.height, 1)
  };
}

function panelSideOpposite(position: FeedbackPinPosition): "left" | "right" {
  return position.x > document.documentElement.clientWidth / 2 ? "left" : "right";
}

function FeedbackContextMenu({
  value,
  onClose,
  onSelect
}: {
  value: ContextMenuState;
  onClose(): void;
  onSelect(): void;
}) {
  const panelRef = useDismissiblePanel<HTMLDivElement>(onClose);
  const menuWidth = 220;
  const menuHeight = 48;
  const margin = 8;
  const left = Math.max(margin, Math.min(value.clientX, window.innerWidth - menuWidth - margin));
  const top = Math.max(margin, Math.min(value.clientY, window.innerHeight - menuHeight - margin));
  return (
    <svg className="feedback-context-menu-layer">
      <foreignObject x={left} y={top} width={menuWidth} height={menuHeight + 12} className="feedback-context-menu-host">
        <div
          ref={panelRef}
          className="feedback-context-menu"
          role="menu"
          aria-label="フィードバックメニュー"
          onContextMenu={(event) => event.preventDefault()}
        >
          <button type="button" role="menuitem" onClick={onSelect}>フィードバックを残す</button>
        </div>
      </foreignObject>
    </svg>
  );
}

function ReviewIntroduction({
  session,
  location,
  scope,
  visible,
  autoOpen,
  storageKey = "feedback.review-introduction"
}: {
  session: Session;
  location: Location;
  scope: "reviewable" | "excluded" | "unregistered";
  visible: boolean;
  autoOpen: boolean;
  storageKey?: string;
}) {
  const feedback = useFeedback();
  const dismissedKey = `${storageKey}.${session.applicationKey}.${session.environmentKey}.${session.externalWorkspaceKey}.${session.id}`;
  const [open, setOpen] = useState(() => autoOpen && !isDismissed(dismissedKey));
  const reviewableScopes = session.scopes.filter((item) => item.reviewable);
  const active = activePerspectivesForLocation(session, location);
  const activeCodes = new Set(active.map((item) => item.code));
  const inactive = session.perspectives.filter((item) => !activeCodes.has(item.code));
  const scopeLabel = scope === "reviewable" ? "この画面は対象" : "この画面は対象外";
  const period = formatReviewPeriod(session.startAt, session.endAt);
  useEffect(() => {
    setOpen(autoOpen && !isDismissed(dismissedKey));
  }, [autoOpen, dismissedKey]);
  const dismiss = () => {
    setOpen(false);
    markDismissed(dismissedKey);
  };
  if (!visible) return null;
  return (
    <>
      <button
        type="button"
        className={`feedback-review-guide-button is-${scope}`}
        aria-label={`レビュー通知：${session.title}（${scopeLabel}、対象${reviewableScopes.length}画面）`}
        onClick={() => setOpen(true)}
      >
        <svg className="feedback-review-bell" aria-hidden="true" viewBox="0 0 24 24">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
        </svg>
        <span className="feedback-review-guide-copy"><strong>レビュー受付中</strong><small>{session.title}・{scopeLabel}</small></span>
        <span className="feedback-review-count" aria-hidden="true">{reviewableScopes.length}</span>
      </button>
      {open ? (
        <div className="feedback-review-guide-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) dismiss();
        }}>
          <section className="feedback-review-guide" role="dialog" aria-modal="true" aria-labelledby="feedback-review-guide-title">
            <header className="feedback-review-guide-header">
              <div><p className="feedback-eyebrow">レビュー受付中</p><h2 id="feedback-review-guide-title">{session.title}</h2></div>
              <button type="button" className="feedback-icon-button" aria-label="レビュー案内を閉じる" onClick={dismiss}>×</button>
            </header>
            {period ? <p className="feedback-review-period">{period}</p> : null}
            {session.description ? <p className="feedback-review-description">{session.description}</p> : null}
            <p className={`feedback-current-scope is-${scope}`}>{scopeLabel}</p>
            <div className="feedback-review-focus-grid">
              <PerspectiveSummary title="今回確認してほしいこと" active perspectives={active} />
              <PerspectiveSummary title="今回は確認しなくてよいこと" active={false} perspectives={inactive} />
            </div>
            {session.scopes.length > 0 ? (
              <section className="feedback-review-section">
                <div className="feedback-review-section-heading">
                  <div><h3>今回の対象画面</h3><p>レビュー対象として登録された画面です。</p></div>
                  <strong>{reviewableScopes.length}画面</strong>
                </div>
                <ul className="feedback-review-scope-list">
                  {session.scopes.map((item) => (
                    <li key={`${item.pageKey}:${item.routeTemplate ?? "*"}`} className={item.reviewable ? "" : "is-excluded"}>
                      <span className="feedback-review-scope-icon" aria-hidden="true">▣</span>
                      <span className="feedback-review-scope-copy">
                        <strong>{item.pageKey}</strong>
                        <small>{item.routeTemplate ?? "すべてのroute"}</small>
                        {item.perspectiveCodes?.length ? <em>{item.perspectiveCodes.join("・")}</em> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <div className="feedback-review-guide-actions">
              <button type="button" className="feedback-button-primary" onClick={dismiss}>確認してレビューを始める</button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function PerspectiveSummary({
  title,
  active,
  perspectives
}: {
  title: string;
  active: boolean;
  perspectives: Session["perspectives"];
}) {
  return (
    <section className={`feedback-review-focus ${active ? "is-active" : "is-inactive"}`}>
      <header><span aria-hidden="true">{active ? "✓" : "−"}</span><div><h3>{title}</h3><small>{perspectives.length}項目</small></div></header>
      {perspectives.length > 0 ? (
        <ul>{perspectives.map((item) => (
          <li key={item.code}>
            {!active ? <span className="feedback-review-status-label">{item.status === "future" ? "今後確認" : "今回対象外"}</span> : null}
            <strong>{item.label}</strong>
            {item.guidance ? <span>{item.guidance}</span> : null}
          </li>
        ))}</ul>
      ) : <p>{active ? "具体的な確認観点は設定されていません。" : "確認不要として指定された観点はありません。"}</p>}
    </section>
  );
}

function ReviewInactiveStatus({ managementUrl }: { managementUrl: string }) {
  return (
    <div className="feedback-review-status is-inactive" role="status">
      <span className="feedback-review-status-dot" />
      <span><strong>レビューは開始されていません</strong><small>対象画面と観点を設定して受付を開始できます</small></span>
      <a href={managementUrl} target="_blank" rel="noreferrer">レビューを開始</a>
    </div>
  );
}

function PanelHeader({
  title,
  onClose,
  closeLabel
}: {
  title: string;
  onClose(): void;
  closeLabel: string;
}) {
  return (
    <header className="feedback-panel-header">
      <h2>{title}</h2>
      <button type="button" className="feedback-icon-button" aria-label={closeLabel} onClick={onClose}>×</button>
    </header>
  );
}

function useDismissiblePanel<T extends HTMLElement>(onDismiss: () => void) {
  const panelRef = useRef<T>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const panel = panelRef.current;
      if (!panel || !(event.target instanceof Node) || panel.contains(event.target)) return;
      onDismissRef.current();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismissRef.current();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);
  return panelRef;
}

function useEvidencePreview(evidence: FeedbackEvidencePayload | null): string | null {
  const url = useMemo(() => {
    if (!evidence || typeof URL.createObjectURL !== "function") return null;
    return URL.createObjectURL(new Blob([evidence.bytes.slice().buffer as ArrayBuffer], { type: evidence.contentType }));
  }, [evidence]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return url;
}

function targetAtEvent(element: Element | null, event: MouseEvent): Target {
  return resolveDomFeedbackTarget({
    element,
    clientX: event.clientX,
    clientY: event.clientY,
    viewportWidth: document.documentElement.clientWidth,
    viewportHeight: document.documentElement.clientHeight
  }) as Target;
}

function findFeedbackElement(key: string): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>(`[${feedbackElementKeyAttribute}]`))
    .find((candidate) => candidate.getAttribute(feedbackElementKeyAttribute) === key) ?? null;
}

function activePerspectivesForLocation(session: Session | null | undefined, location: Location | null) {
  if (!session) return [];
  const globallyActive = session.perspectives.filter((item) => item.status === "active");
  if (!location) return globallyActive;
  const samePage = session.scopes.filter((item) => item.pageKey === location.pageKey && item.reviewable);
  const scope = samePage.find((item) => item.routeTemplate === location.routeTemplate)
    ?? samePage.find((item) => item.routeTemplate == null);
  if (!scope?.perspectiveCodes?.length) return globallyActive;
  const assigned = new Set(scope.perspectiveCodes);
  return globallyActive.filter((item) => assigned.has(item.code));
}

function shouldPromptParticipant(feedback: ReturnType<typeof useFeedback>): boolean {
  return feedback.features.participantPrompt === true ||
    feedback.reviewContext?.participantPolicy.mode !== "authenticated-identity";
}

function describeTarget(target: Target): string {
  switch (target.kind) {
    case "ui-element": return target.elementKey;
    case "screen-position": return `画面上の位置 (${formatRelative(target.relativeX)}, ${formatRelative(target.relativeY)})`;
    case "map-feature": return `地物 ${target.sourceKey}/${target.featureKey}`;
    case "map-position": return `地図上の地点 (${target.longitude.toFixed(5)}, ${target.latitude.toFixed(5)})`;
  }
}

function perspectiveLabel(session: Session, code: string): string {
  return session.perspectives.find((item) => item.code === code)?.label ?? code;
}

function participantLabel(participant: Schemas["FeedbackParticipant"]): string {
  return participant.participantName ?? participant.displayName ?? participant.principalId;
}

function threadLabel(thread: Thread, session: Session): string {
  const body = thread.messages[0]?.body ?? "コメント";
  return `#${thread.displayNumber} ${perspectiveLabel(session, thread.perspectiveCode)}: ${body}${thread.status === "resolved" ? " (解決済み)" : ""}`;
}

function lastMessageBody(thread: Thread): string {
  return thread.messages[thread.messages.length - 1]?.body ?? "コメントはありません";
}

function evidenceBody(value: FeedbackEvidencePayload) {
  return {
    contentType: value.contentType,
    dataBase64: bytesToBase64(value.bytes),
    viewportWidth: value.viewportWidth,
    viewportHeight: value.viewportHeight,
    pixelRatio: value.pixelRatio,
    capturedAt: value.capturedAt
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function idempotencyKey(): string {
  return `feedback-${globalThis.crypto.randomUUID()}`;
}

function versionEtag(version: number): string {
  return `"v${version}"`;
}

function formatRelative(value: number): string {
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatReviewPeriod(startAt?: string | null, endAt?: string | null): string | null {
  if (!startAt && !endAt) return null;
  const format = (value?: string | null) => {
    if (!value) return "未設定";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" });
  };
  return `${format(startAt)} 〜 ${format(endAt)}`;
}

function isDismissed(key: string): boolean {
  if (typeof window === "undefined") return false;
  try { return window.localStorage.getItem(key) === "dismissed"; } catch { return false; }
}

function markDismissed(key: string): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(key, "dismissed"); } catch {
    // localStorageが無効でも現在のmount中はstateで閉じた状態を維持する。
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type LocalStorageParticipantAdapter = {
  getParticipantName(): string | null;
  setParticipantName(value: string | null): void;
};

/** localStorage は明示 opt-in の identity adapter としてだけ提供する。 */
export function createLocalStorageParticipantAdapter(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  key = "feedback.participant-name"
): LocalStorageParticipantAdapter {
  return {
    getParticipantName: () => {
      try {
        return storage.getItem(key);
      } catch {
        return null;
      }
    },
    setParticipantName: (value) => {
      try {
        if (value) storage.setItem(key, value.slice(0, 100));
        else storage.removeItem(key);
      } catch {
        // storage 無効時もメモリ内の入力で投稿を継続する。
      }
    }
  };
}
