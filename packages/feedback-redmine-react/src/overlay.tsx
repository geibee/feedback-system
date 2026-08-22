import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type FormEvent
} from "react";
import {
  canonicalJson,
  countUnreadReplies,
  RedmineFeedbackError,
  sha256Hex,
  type RedmineCapabilitiesV1,
  type RedmineClientProfileV1,
  type RedmineCreationOptionsV1,
  type RedmineEvidenceMetadata,
  type RedmineFollowStateV1,
  type RedminePendingIntentV1,
  type RedmineThreadFilter,
  type RedmineThreadSort,
  type RedmineThreadSummaryV1,
  type RedmineThreadV1
} from "@geibee/feedback-redmine-core";
import type { FeedbackEvidencePayload, FeedbackLocationV1, FeedbackTargetV1 } from "@geibee/feedback-core";
import { resolveDomFeedbackTarget } from "@geibee/feedback-react-ui";
import { createDomEvidenceProvider } from "./capture.js";
import { addFeedbackCaptureMarker, type FeedbackCaptureMarkerPosition } from "./capture-marker.js";
import { useDismissiblePanel } from "./dismissible.js";
import { feedbackErrorMessage } from "./error-message.js";
import { useRedmineFeedbackRuntime, type RedmineFeedbackRuntime } from "./provider.js";
import { useVisiblePolling } from "./storage.js";
import { ThreadDrawer } from "./thread-drawer.js";
import { ThreadList } from "./thread-list.js";
import { resolveFeedbackPinPosition, ThreadPins } from "./thread-pins.js";

export type RedmineFeedbackOverlayHandle = {
  refresh(): Promise<void>;
  openThread(threadId: string): Promise<void>;
};

export type RedmineFeedbackOverlayProps = {
  onUnavailable?: (error: unknown) => void;
};

type CaptureState =
  | { kind: "disabled"; reason: "profile" }
  | { kind: "capturing" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; payload: FeedbackEvidencePayload; url: string };

type ContextMenuState = {
  clientX: number;
  clientY: number;
  target: FeedbackTargetV1;
};

export const RedmineFeedbackOverlay = forwardRef<
  RedmineFeedbackOverlayHandle,
  RedmineFeedbackOverlayProps
>(function RedmineFeedbackOverlay(props, ref) {
  const runtime = useRedmineFeedbackRuntime();
  const controller = useMemo(() => new AbortController(), []);
  const captureGeneration = useRef(0);
  const selectedGeneration = useRef(0);
  const navigating = useRef(false);
  const captureRef = useRef<CaptureState>({ kind: "disabled", reason: "profile" });
  const [profile, setProfile] = useState<RedmineClientProfileV1 | null>(null);
  const [capabilities, setCapabilities] = useState<RedmineCapabilitiesV1 | null>(null);
  const [principal, setPrincipal] = useState<{ participantId: string } | null>(null);
  const [principalScopeHash, setPrincipalScopeHash] = useState("");
  const [resourceThreads, setResourceThreads] = useState<RedmineThreadSummaryV1[]>([]);
  const resourceThreadsRef = useRef<RedmineThreadSummaryV1[]>([]);
  const [workspaceThreads, setWorkspaceThreads] = useState<RedmineThreadSummaryV1[]>([]);
  const workspaceThreadsRef = useRef<RedmineThreadSummaryV1[]>([]);
  const [workspaceTotalCount, setWorkspaceTotalCount] = useState(0);
  const [workspaceNextCursor, setWorkspaceNextCursor] = useState<string | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [sort, setSort] = useState<RedmineThreadSort>("updated_desc");
  const [filter, setFilter] = useState<RedmineThreadFilter>({});
  const [browseOpen, setBrowseOpen] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedThread, setSelectedThread] = useState<RedmineThreadV1 | null>(null);
  const [selectedError, setSelectedError] = useState<string | null>(null);
  const [drawerSide, setDrawerSide] = useState<"left" | "right">("right");
  const [followed, setFollowed] = useState(false);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [participantName, setParticipantName] = useState("");
  const [perspectiveCode, setPerspectiveCode] = useState("");
  const [creationOptions, setCreationOptions] = useState<RedmineCreationOptionsV1>({ optionalIssueFields: [], priorities: [] });
  const [parentIssueId, setParentIssueId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [priorityId, setPriorityId] = useState("");
  const [capture, setCapture] = useState<CaptureState>({ kind: "disabled", reason: "profile" });
  const [captureWarning, setCaptureWarning] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submissionInFlight = useRef(false);
  const [submissionTarget, setSubmissionTarget] = useState<FeedbackTargetV1 | null>(null);
  const [submissionPosition, setSubmissionPosition] = useState<FeedbackCaptureMarkerPosition | null>(null);
  const [pickingTarget, setPickingTarget] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const replaceCapture = useCallback((next: CaptureState) => {
    const current = captureRef.current;
    if (current.kind === "ready" && (next.kind !== "ready" || next.url !== current.url)) {
      URL.revokeObjectURL(current.url);
    }
    captureRef.current = next;
    setCapture(next);
  }, []);

  useEffect(() => () => {
    controller.abort();
    captureGeneration.current += 1;
    const current = captureRef.current;
    if (current.kind === "ready") URL.revokeObjectURL(current.url);
  }, [controller]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      runtime.port.getCapabilities(runtime.profileId, controller.signal),
      runtime.port.getCurrentUser(runtime.profileId, controller.signal),
      loadCreationOptions(runtime, controller.signal)
    ]).then(async ([result, current, options]) => {
      if (!active) return;
      assertProfileMatchesHost(result.profile, runtime.adapter.getContext());
      const scopeHash = await sha256Hex(new TextEncoder().encode(`${runtime.profileId}\n${current.participantId}`));
      const draft = await runtime.clientState.getDraft(runtime.profileId, scopeHash);
      if (!active) return;
      setProfile(result.profile);
      setCapabilities(result.capabilities);
      setCreationOptions(options);
      setPerspectiveCode(result.profile.perspectives[0]?.code ?? "");
      setPrincipal(current);
      setPrincipalScopeHash(scopeHash);
      setComment(draft ?? "");
      setParticipantName(readParticipantName(runtime.profileId));
    }).catch((reason: unknown) => {
      if (!active || controller.signal.aborted) return;
      setError(feedbackErrorMessage(reason, "接続"));
      props.onUnavailable?.(reason);
    });
    return () => { active = false; };
  }, [controller, props.onUnavailable, runtime]);

  const refreshUnread = useCallback(async (summaries: RedmineThreadSummaryV1[]) => {
    if (!principalScopeHash || !principal) return;
    const states = await runtime.clientState.listFollowStates(runtime.profileId, principalScopeHash);
    const byThread = new Map(summaries.map((thread) => [thread.threadId, thread]));
    let count = 0;
    for (const state of states.filter((item) => item.followed).slice(0, 100)) {
      const summary = byThread.get(state.threadId);
      if (!summary || summary.updatedAt <= state.lastSeenIssueUpdatedOn) continue;
      try {
        const detail = await runtime.port.getThread({
          profileId: runtime.profileId,
          resourceRef: runtime.adapter.getResourceRef(),
          threadId: state.threadId
        }, controller.signal);
        count += detail.messages
          ? detail.messages.filter((message) => message.kind === "reply" && message.journalId !== null &&
            !(state.seenJournalIds ?? []).includes(message.journalId) &&
            message.author.participantId !== principal.participantId).length
          : countUnreadReplies(
            detail.timeline.flatMap((item) => item.kind === "reply"
              ? [{ id: item.journalId, notes: item.body, authorId: item.author.id }]
              : []),
            state,
            null
          );
      } catch {
        // 個別threadの失敗でlauncherを壊さない。
      }
    }
    setUnread(count);
  }, [controller.signal, principal, principalScopeHash, runtime]);

  const loadResourceThreads = useCallback(async () => {
    if (!profile) return;
    const location = runtime.adapter.getLocation();
    if (!location) {
      resourceThreadsRef.current = [];
      setResourceThreads([]);
      return;
    }
    try {
      const result = await runtime.port.listThreads({
        profileId: runtime.profileId,
        resourceRef: runtime.adapter.getResourceRef(),
        pageKey: location.pageKey,
        sort: "updated_desc",
        filter: {}
      }, controller.signal);
      const visible = result.threads.filter((thread) =>
        thread.locator ? feedbackLocationMatches(thread.locator.location, location) : false
      );
      resourceThreadsRef.current = visible;
      setResourceThreads(visible);
      await refreshUnread(visible);
      setError(null);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(feedbackErrorMessage(reason, "一覧"));
        props.onUnavailable?.(reason);
      }
    }
  }, [controller.signal, profile, props.onUnavailable, refreshUnread, runtime]);

  const loadWorkspaceThreads = useCallback(async (cursor: string | undefined, append: boolean) => {
    if (!profile) return;
    setWorkspaceLoading(true);
    try {
      const result = await runtime.port.listThreads({
        profileId: runtime.profileId,
        scope: "workspace",
        sort,
        filter,
        ...(cursor === undefined ? {} : { cursor })
      }, controller.signal);
      const combined = append
        ? [...workspaceThreadsRef.current.filter((current) =>
          !result.threads.some((next) => next.threadId === current.threadId)), ...result.threads]
        : result.threads;
      workspaceThreadsRef.current = combined;
      setWorkspaceThreads(combined);
      setWorkspaceTotalCount(result.totalCount);
      setWorkspaceNextCursor(result.nextCursor);
      setWorkspaceError(null);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setWorkspaceError(feedbackErrorMessage(reason, "一覧"));
        props.onUnavailable?.(reason);
      }
    } finally {
      setWorkspaceLoading(false);
    }
  }, [controller.signal, filter, profile, props.onUnavailable, runtime, sort]);

  const refresh = useCallback(async () => {
    await Promise.all([loadResourceThreads(), loadWorkspaceThreads(undefined, false)]);
  }, [loadResourceThreads, loadWorkspaceThreads]);

  const refreshSelected = useCallback(async () => {
    if (!selectedThreadId) return;
    const generation = ++selectedGeneration.current;
    try {
      const detail = await runtime.port.getThread({
        profileId: runtime.profileId,
        resourceRef: runtime.adapter.getResourceRef(),
        threadId: selectedThreadId
      }, controller.signal);
      if (generation !== selectedGeneration.current) return;
      setSelectedThread((current) => threadVersion(current) === threadVersion(detail) ? current : detail);
      setSelectedError(null);
      if (principalScopeHash) {
        const current = await runtime.clientState.getFollowState(runtime.profileId, principalScopeHash, detail.threadId);
        const next = readState(detail, runtime.profileId, principalScopeHash, current?.followed ?? false);
        await runtime.clientState.setFollowState(next);
        if (generation === selectedGeneration.current) setFollowed(next.followed);
      }
    } catch (reason) {
      if (!controller.signal.aborted && generation === selectedGeneration.current) {
        setSelectedError(`${feedbackErrorMessage(reason, "詳細")} 最後に取得した内容があれば継続表示します。`);
        props.onUnavailable?.(reason);
      }
    }
  }, [controller.signal, principalScopeHash, props.onUnavailable, runtime, selectedThreadId]);

  useEffect(() => {
    if (profile) void refresh();
  }, [profile, refresh]);
  useEffect(() => {
    const diagnostics = runtime.captureDiagnostics;
    if (!profile?.capture.enabled || !diagnostics) {
      setCaptureWarning(null);
      return;
    }
    const refreshWarning = () => setCaptureWarning(diagnostics.getWarning());
    refreshWarning();
    const unsubscribe = diagnostics.subscribe(refreshWarning);
    const observer = new MutationObserver((records) => {
      if (records.some(canvasMutationMayChangeDiagnostic)) refreshWarning();
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class"]
    });
    return () => {
      observer.disconnect();
      unsubscribe();
    };
  }, [profile?.capture.enabled, runtime.captureDiagnostics]);
  useEffect(() => {
    if (browseOpen && profile) void loadWorkspaceThreads(undefined, false);
  }, [browseOpen, filter, loadWorkspaceThreads, profile, sort]);
  useEffect(() => {
    if (selectedThreadId) {
      setSelectedThread(null);
      void refreshSelected();
    }
  }, [refreshSelected, selectedThreadId]);
  useEffect(() => runtime.adapter.subscribe?.(() => {
    if (navigating.current) return;
    captureGeneration.current += 1;
    selectedGeneration.current += 1;
    setPickingTarget(false);
    setContextMenu(null);
    setSubmissionTarget(null);
    setSubmissionPosition(null);
    replaceCapture({ kind: "disabled", reason: "profile" });
    setBrowseOpen(false);
    setSelectedThreadId(null);
    setSelectedThread(null);
    void refresh();
  }), [refresh, replaceCapture, runtime.adapter]);
  useVisiblePolling(browseOpen, 15_000, () => loadWorkspaceThreads(undefined, false));
  useVisiblePolling(Boolean(selectedThreadId), 15_000, refreshSelected);

  const closeThread = useCallback(() => {
    selectedGeneration.current += 1;
    setSelectedThreadId(null);
    setSelectedThread(null);
    setSelectedError(null);
    setFollowed(false);
  }, []);

  const openCurrentThread = useCallback(async (threadId: string, position?: { x: number; y: number }) => {
    setBrowseOpen(false);
    setSubmissionTarget(null);
    setSubmissionPosition(null);
    replaceCapture({ kind: "disabled", reason: "profile" });
    setDrawerSide(position && position.x > document.documentElement.clientWidth / 2 ? "left" : "right");
    setSelectedError(null);
    setSelectedThreadId(threadId);
  }, [replaceCapture]);

  const openWorkspaceThread = useCallback(async (thread: RedmineThreadSummaryV1) => {
    const destination = thread.locator?.location;
    if (!destination) {
      setWorkspaceError("この投稿には場所情報がないため、ホスト画面から開けません。");
      return;
    }
    try {
      const current = runtime.adapter.getLocation();
      if (!current || !feedbackLocationMatches(current, destination)) {
        navigating.current = true;
        await runtime.adapter.navigate(destination, thread.threadId);
        const arrived = runtime.adapter.getLocation();
        if (!arrived || !feedbackLocationMatches(arrived, destination)) {
          throw new Error("対象画面への移動を確認できませんでした");
        }
      }
      setBrowseOpen(false);
      setWorkspaceError(null);
      setSelectedThreadId(thread.threadId);
      setSelectedThread(null);
      await loadResourceThreads();
    } catch (reason) {
      setWorkspaceError(feedbackErrorMessage(reason, "画面移動"));
    } finally {
      navigating.current = false;
    }
  }, [loadResourceThreads, runtime.adapter]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get("feedbackThread");
    const fromHash = /(?:^|[&#])feedbackThread=([0-9a-f-]{36})(?:&|$)/iu.exec(url.hash.slice(1))?.[1] ?? null;
    const threadId = fromQuery ?? fromHash;
    if (threadId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(threadId)) {
      void openCurrentThread(threadId);
    }
  }, [openCurrentThread]);
  useImperativeHandle(ref, () => ({ refresh, openThread: openCurrentThread }), [openCurrentThread, refresh]);

  const captureEvidence = useCallback(async (
    target: FeedbackTargetV1,
    selectedPosition: FeedbackCaptureMarkerPosition | null
  ) => {
    const generation = ++captureGeneration.current;
    if (!profile?.capture.enabled) {
      replaceCapture({ kind: "disabled", reason: "profile" });
      return;
    }
    const location = runtime.adapter.getLocation();
    if (!location) {
      replaceCapture({ kind: "failed", message: "現在の画面情報を取得できませんでした。コメントのみ投稿します。" });
      return;
    }
    replaceCapture({ kind: "capturing" });
    try {
      setCaptureWarning(runtime.captureDiagnostics?.getWarning() ?? null);
      const baseProvider = runtime.adapter.captureEvidence ?? createDomEvidenceProvider({
        maxBytes: profile.capture.maximumUploadBytes
      });
      const provider = runtime.captureDiagnostics?.wrapProvider?.(baseProvider) ?? baseProvider;
      let payload = await provider({
        context: runtime.adapter.getContext(),
        location,
        target,
        excludeSelector: "[data-feedback-redmine-ui]",
        maskSelector: "[data-feedback-mask]"
      });
      if (generation !== captureGeneration.current) return;
      if (!payload) throw new Error("スクリーンショットを生成できませんでした");
      const markerPosition = resolveFeedbackPinPosition(target, runtime.pinPositionProvider) ?? selectedPosition;
      if (!markerPosition) throw new Error("フィードバック位置をスクリーンショットへ描画できませんでした");
      payload = await addFeedbackCaptureMarker(payload, markerPosition);
      if (payload.bytes.byteLength > profile.capture.maximumUploadBytes ||
        !profile.capture.contentTypes.includes(payload.contentType)) {
        throw new Error("スクリーンショットがProfileの添付条件を満たしません");
      }
      replaceCapture({
        kind: "ready",
        payload,
        url: URL.createObjectURL(new Blob([Uint8Array.from(payload.bytes).buffer], { type: payload.contentType }))
      });
    } catch (reason) {
      if (generation === captureGeneration.current) {
        replaceCapture({
          kind: "failed",
          message: `画面キャプチャの取得に失敗しました（${reason instanceof Error ? reason.message : "原因不明"}）。コメントのみ投稿します。`
        });
      }
    }
  }, [profile, replaceCapture, runtime.adapter, runtime.pinPositionProvider]);

  const beginComposer = useCallback((target: FeedbackTargetV1, position: FeedbackCaptureMarkerPosition) => {
    setContextMenu(null);
    setPickingTarget(false);
    setBrowseOpen(false);
    closeThread();
    setSubmissionTarget(target);
    setSubmissionPosition(position);
    void captureEvidence(target, position);
  }, [captureEvidence, closeThread]);

  const resolvePointerTarget = useCallback((clientX: number, clientY: number, action: "pick" | "context-menu") => {
    const element = document.elementFromPoint?.(clientX, clientY) ?? null;
    if (element?.closest("[data-feedback-redmine-ui]")) return null;
    return runtime.targetResolver?.({ action, element, clientX, clientY }) ??
      resolveDomFeedbackTarget({ element, clientX, clientY });
  }, [runtime.targetResolver]);

  useEffect(() => {
    const click = (event: MouseEvent) => {
      if (!pickingTarget) return;
      if (eventFromFeedbackUi(event)) return;
      const target = resolvePointerTarget(event.clientX, event.clientY, "pick");
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      beginComposer(target, { x: event.clientX, y: event.clientY });
    };
    document.addEventListener("click", click, true);
    return () => document.removeEventListener("click", click, true);
  }, [beginComposer, pickingTarget, resolvePointerTarget]);

  const idle = !pickingTarget && !submissionTarget && !browseOpen && !selectedThreadId && !contextMenu;
  useEffect(() => {
    const contextMenuListener = (event: MouseEvent) => {
      if (!runtime.contextMenu || !idle || capabilities?.canCreate !== true ||
        eventFromFeedbackUi(event)) return;
      const target = resolvePointerTarget(event.clientX, event.clientY, "context-menu");
      if (!target) return;
      event.preventDefault();
      setContextMenu({ clientX: event.clientX, clientY: event.clientY, target });
    };
    document.addEventListener("contextmenu", contextMenuListener, true);
    return () => document.removeEventListener("contextmenu", contextMenuListener, true);
  }, [capabilities?.canCreate, idle, resolvePointerTarget, runtime.contextMenu]);

  const closeComposer = useCallback(() => {
    captureGeneration.current += 1;
    setSubmissionTarget(null);
    setSubmissionPosition(null);
    replaceCapture({ kind: "disabled", reason: "profile" });
  }, [replaceCapture]);

  const submit = async () => {
    if (!profile || !principalScopeHash || !comment.trim() || comment.trim().length > 20_000 ||
      !perspectiveCode || submissionInFlight.current || !submissionTarget ||
      (parentIssueId !== "" && !/^[1-9][0-9]*$/u.test(parentIssueId)) ||
      (priorityId !== "" && !/^[1-9][0-9]*$/u.test(priorityId))) return;
    const location = runtime.adapter.getLocation();
    if (!location) return;
    setSubmitting(true);
    submissionInFlight.current = true;
    let pendingIntent: RedminePendingIntentV1 | null = null;
    try {
      const selectedParentIssueId = parentIssueId ? Number(parentIssueId) : undefined;
      const selectedPriorityId = priorityId ? Number(priorityId) : undefined;
      const attachedCapture = capture.kind === "ready" ? capture : null;
      const evidenceSha256 = attachedCapture ? await sha256Hex(attachedCapture.payload.bytes) : null;
      const localHash = await sha256Hex(new TextEncoder().encode(canonicalJson({
        comment: comment.trim(), perspectiveCode, location, evidenceSha256,
        parentIssueId: selectedParentIssueId, dueDate: dueDate || undefined, priorityId: selectedPriorityId
      })));
      const existing = await runtime.clientState.getPendingIntent(runtime.profileId, principalScopeHash);
      const threadId = existing?.clientDraftHash === localHash ? existing.threadId : crypto.randomUUID();
      const intentId = existing?.clientDraftHash === localHash ? existing.intentId : crypto.randomUUID();
      const hostThreadUrl = runtime.adapter.getFeedbackThreadUrl?.(threadId);
      const threadUrl = hostThreadUrl === undefined ? buildFeedbackThreadUrl(window.location, threadId) : hostThreadUrl;
      pendingIntent = {
        schemaVersion: "1",
        profileId: runtime.profileId,
        threadId,
        intentId,
        clientDraftHash: localHash,
        createdAt: existing?.clientDraftHash === localHash ? existing.createdAt : new Date().toISOString(),
        state: "prepared"
      };
      await runtime.clientState.setPendingIntent(runtime.profileId, principalScopeHash, pendingIntent);
      const evidence: RedmineEvidenceMetadata | null = attachedCapture ? {
        filename: `feedback-${threadId}.${attachedCapture.payload.contentType === "image/png" ? "png" : "webp"}`,
        contentType: attachedCapture.payload.contentType,
        byteSize: attachedCapture.payload.bytes.byteLength,
        sha256: evidenceSha256!,
        viewportWidth: attachedCapture.payload.viewportWidth,
        viewportHeight: attachedCapture.payload.viewportHeight,
        pixelRatio: attachedCapture.payload.pixelRatio,
        capturedAt: attachedCapture.payload.capturedAt
      } : null;
      const context = runtime.adapter.getContext();
      const created = await runtime.port.createThread({
        profileId: runtime.profileId,
        resourceRef: runtime.adapter.getResourceRef(),
        threadId,
        intentId,
        comment: comment.trim(),
        perspectiveCode,
        location,
        target: submissionTarget,
        release: context.release,
        locale: context.locale ?? (document.documentElement.lang || "ja-JP"),
        threadUrl,
        capturedAt: new Date().toISOString(),
        evidence,
        participantName: participantName.trim() || null,
        ...(selectedParentIssueId === undefined ? {} : { parentIssueId: selectedParentIssueId }),
        ...(dueDate ? { dueDate } : {}),
        ...(selectedPriorityId === undefined ? {} : { priorityId: selectedPriorityId })
      }, attachedCapture?.payload.bytes ?? null, controller.signal);
      await runtime.clientState.setPendingIntent(runtime.profileId, principalScopeHash, null);
      await runtime.clientState.setDraft(runtime.profileId, principalScopeHash, null);
      await runtime.clientState.setFollowState(readState(created, runtime.profileId, principalScopeHash, true));
      setComment("");
      setParentIssueId("");
      setDueDate("");
      setPriorityId("");
      writeParticipantName(runtime.profileId, participantName);
      closeComposer();
      await refresh();
      await openCurrentThread(created.threadId);
    } catch (reason) {
      if (pendingIntent && reason instanceof RedmineFeedbackError && reason.retryable) {
        await runtime.clientState.setPendingIntent(runtime.profileId, principalScopeHash, {
          ...pendingIntent,
          state: "uncertain"
        }).catch(() => undefined);
        setError("作成された可能性があります。同じ内容で再確認してください。draftとretry intentはこの端末に保持しています。");
      } else setError(feedbackErrorMessage(reason, "投稿"));
      props.onUnavailable?.(reason);
    } finally {
      submissionInFlight.current = false;
      setSubmitting(false);
    }
  };

  const toggleFollow = async (next: boolean) => {
    if (!selectedThread || !principalScopeHash) return;
    await runtime.clientState.setFollowState(readState(selectedThread, runtime.profileId, principalScopeHash, next));
    setFollowed(next);
    await refreshUnread(resourceThreads);
  };

  return <div className="feedback-redmine-root" data-feedback-redmine-ui="true">
    <ThreadPins
      threads={resourceThreads}
      positionProvider={runtime.pinPositionProvider}
      activeThreadId={selectedThreadId}
      onActiveSideChange={setDrawerSide}
      onOpen={(threadId, position) => void openCurrentThread(threadId, position)}
    />
    {idle && profile && <>
      {capabilities?.canCreate && <button
        className="feedback-redmine-launcher"
        type="button"
        onClick={() => {
          setError(null);
          setPickingTarget(true);
        }}
      ><span aria-hidden="true">＋</span> フィードバック</button>}
      {capabilities?.canRead && <button
        className="feedback-redmine-thread-list-launcher"
        type="button"
        onClick={() => setBrowseOpen(true)}
      >他の人の投稿を見る <span className="feedback-redmine-thread-count">{workspaceTotalCount}</span>
        {unread > 0 && <span className="feedback-redmine-unread-badge" aria-label={`未読の返信 ${unread}件`}>{unread > 99 ? "99+" : unread}</span>}
      </button>}
    </>}
    {pickingTarget && <div className="feedback-redmine-picking-bar" role="status" aria-live="polite">
      <span>フィードバックする場所をクリックしてください</span>
      <button type="button" className="feedback-redmine-button-secondary" onClick={() => setPickingTarget(false)}>キャンセル</button>
    </div>}
    {submissionTarget && profile && <Composer
      profile={profile}
      target={submissionTarget}
      capture={capture}
      captureWarning={captureWarning}
      participantName={participantName}
      perspectiveCode={perspectiveCode}
      comment={comment}
      creationOptions={creationOptions}
      submissionNotice={runtime.submissionNotice}
      parentIssueId={parentIssueId}
      dueDate={dueDate}
      priorityId={priorityId}
      submitting={submitting}
      onParticipantNameChange={setParticipantName}
      onPerspectiveChange={setPerspectiveCode}
      onCommentChange={(value) => {
        setComment(value);
        if (principalScopeHash) void runtime.clientState.setDraft(runtime.profileId, principalScopeHash, value || null);
      }}
      onParentIssueIdChange={setParentIssueId}
      onDueDateChange={setDueDate}
      onPriorityIdChange={setPriorityId}
      onRecapture={() => void captureEvidence(submissionTarget, submissionPosition)}
      onBrowse={() => {
        closeComposer();
        setBrowseOpen(true);
      }}
      onClose={closeComposer}
      onSubmit={submit}
    />}
    {browseOpen && profile && <ThreadList
      profile={profile}
      threads={workspaceThreads}
      totalCount={workspaceTotalCount}
      sort={sort}
      filter={filter}
      loading={workspaceLoading}
      nextCursor={workspaceNextCursor}
      error={workspaceError}
      onClose={() => setBrowseOpen(false)}
      onSortChange={setSort}
      onFilterChange={setFilter}
      onOpen={(thread) => void openWorkspaceThread(thread)}
      onLoadMore={() => workspaceNextCursor && void loadWorkspaceThreads(workspaceNextCursor, true)}
    />}
    {selectedThreadId && <ThreadDrawer
      thread={selectedThread}
      loading={!selectedThread}
      error={selectedError}
      followed={followed}
      side={drawerSide}
      onClose={closeThread}
      onFollowChange={(next) => void toggleFollow(next)}
      canReply={capabilities?.canReply === true}
      canEditOwn={capabilities?.canEditOwn === true}
      participantName={participantName}
      onReply={async (body) => {
        const updated = await runtime.port.createMessage({
          profileId: runtime.profileId,
          resourceRef: runtime.adapter.getResourceRef(),
          threadId: selectedThreadId,
          messageId: crypto.randomUUID(),
          intentId: crypto.randomUUID(),
          body,
          participantName: participantName.trim() || null
        }, controller.signal);
        writeParticipantName(runtime.profileId, participantName);
        setSelectedThread(updated);
        await refresh();
      }}
      onEdit={async (messageId, body, expectedVersion) => {
        const updated = await runtime.port.updateMessage({
          profileId: runtime.profileId,
          resourceRef: runtime.adapter.getResourceRef(),
          threadId: selectedThreadId,
          messageId,
          intentId: crypto.randomUUID(),
          body,
          expectedVersion,
          participantName: participantName.trim() || null
        }, controller.signal);
        writeParticipantName(runtime.profileId, participantName);
        setSelectedThread(updated);
        await refresh();
      }}
      onAttachment={(attachmentId) => runtime.port.getAttachment({
        profileId: runtime.profileId,
        resourceRef: runtime.adapter.getResourceRef(),
        threadId: selectedThreadId,
        attachmentId
      }, controller.signal)}
    />}
    {contextMenu && <FeedbackContextMenu
      value={contextMenu}
      onClose={() => setContextMenu(null)}
      onSelect={() => beginComposer(contextMenu.target, { x: contextMenu.clientX, y: contextMenu.clientY })}
    />}
    {error && <p className="feedback-redmine-toast feedback-redmine-error" role="alert">{error}</p>}
    {captureWarning && !submissionTarget && !error && <p
      className="feedback-redmine-toast feedback-redmine-warning"
      role="status"
    >{captureWarning}</p>}
  </div>;
});

async function loadCreationOptions(
  runtime: RedmineFeedbackRuntime,
  signal: AbortSignal
): Promise<RedmineCreationOptionsV1> {
  if (!runtime.port.getCreationOptions) return { optionalIssueFields: [], priorities: [] };
  try {
    return await runtime.port.getCreationOptions(runtime.profileId, signal);
  } catch (error) {
    if (error instanceof RedmineFeedbackError &&
      (error.code === "redmine.not_found" || error.upstreamStatus === 404)) {
      return { optionalIssueFields: [], priorities: [] };
    }
    throw error;
  }
}

function canvasMutationMayChangeDiagnostic(record: MutationRecord): boolean {
  if (record.type === "attributes") return record.target instanceof HTMLCanvasElement;
  return [...record.addedNodes, ...record.removedNodes].some((node) =>
    node instanceof HTMLCanvasElement || (node instanceof Element && node.querySelector("canvas") !== null)
  );
}

function Composer(props: {
  profile: RedmineClientProfileV1;
  target: FeedbackTargetV1;
  capture: CaptureState;
  captureWarning: string | null;
  participantName: string;
  perspectiveCode: string;
  comment: string;
  creationOptions: RedmineCreationOptionsV1;
  submissionNotice: RedmineFeedbackRuntime["submissionNotice"];
  parentIssueId: string;
  dueDate: string;
  priorityId: string;
  submitting: boolean;
  onParticipantNameChange(value: string): void;
  onPerspectiveChange(value: string): void;
  onCommentChange(value: string): void;
  onParentIssueIdChange(value: string): void;
  onDueDateChange(value: string): void;
  onPriorityIdChange(value: string): void;
  onRecapture(): void;
  onBrowse(): void;
  onClose(): void;
  onSubmit(): Promise<void>;
}) {
  const panelRef = useDismissiblePanel<HTMLFormElement>(props.onClose);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void props.onSubmit();
  };
  return <form
    ref={panelRef}
    role="dialog"
    aria-label="フィードバックの投稿"
    className="feedback-redmine-panel feedback-redmine-composer"
    onSubmit={submit}
  >
    <PanelHeader title="フィードバック" closeLabel="投稿画面を閉じる" onClose={props.onClose} />
    <p className="feedback-redmine-target-summary">対象: <code>{targetLabel(props.target)}</code></p>
    <button type="button" className="feedback-redmine-text-button feedback-redmine-browse-threads" onClick={props.onBrowse}>
      他の人の投稿を見る
    </button>
    <div className="feedback-redmine-evidence">
      {props.captureWarning && <p className="feedback-redmine-warning" role="status">{props.captureWarning}</p>}
      {props.capture.kind === "capturing" && <p role="status">投稿時点の画面を取得しています…</p>}
      {props.capture.kind === "ready" && <>
        <p>投稿時点の画面キャプチャを自動添付します（{props.capture.payload.viewportWidth}×{props.capture.payload.viewportHeight}）</p>
        <img src={props.capture.url} alt="画面キャプチャのプレビュー" />
      </>}
      {props.capture.kind === "failed" && <p className="feedback-redmine-error" role="alert">{props.capture.message}</p>}
      {props.capture.kind === "disabled" && <p className="feedback-redmine-note">このProfileではスクリーンショット保存が無効です。</p>}
      {props.profile.capture.enabled && <button
        type="button"
        className="feedback-redmine-text-button"
        disabled={props.capture.kind === "capturing"}
        onClick={props.onRecapture}
      >スクリーンショットを再取得</button>}
    </div>
    <fieldset className="feedback-redmine-perspectives">
      <legend>レビュー観点</legend>
      {props.profile.perspectives.map((perspective) => <label key={perspective.code}>
        <input
          type="radio"
          name="feedback-redmine-perspective"
          value={perspective.code}
          checked={props.perspectiveCode === perspective.code}
          onChange={() => props.onPerspectiveChange(perspective.code)}
        />
        <span><strong>{perspective.label}</strong></span>
      </label>)}
    </fieldset>
    <label className="feedback-redmine-field">投稿者名
      <input
        maxLength={100}
        autoComplete="name"
        value={props.participantName}
        onChange={(event) => props.onParticipantNameChange(event.target.value)}
      />
    </label>
    {props.creationOptions.optionalIssueFields.includes("parent_issue") && <label className="feedback-redmine-field">親チケットID
      <input
        type="number"
        min={1}
        step={1}
        value={props.parentIssueId}
        onChange={(event) => props.onParentIssueIdChange(event.target.value)}
      />
    </label>}
    {props.creationOptions.optionalIssueFields.includes("due_date") && <label className="feedback-redmine-field">期限
      <input type="date" value={props.dueDate} onChange={(event) => props.onDueDateChange(event.target.value)} />
    </label>}
    {props.creationOptions.optionalIssueFields.includes("priority") && <label className="feedback-redmine-field">重要度
      <select value={props.priorityId} onChange={(event) => props.onPriorityIdChange(event.target.value)}>
        <option value="">デフォルト</option>
        {props.creationOptions.priorities.map((priority) => <option key={priority.id} value={priority.id}>{priority.name}</option>)}
      </select>
    </label>}
    {props.submissionNotice && <aside className="feedback-redmine-submission-notice">
      <h3>管理者からの案内</h3>
      <p>{props.submissionNotice.message}</p>
      {props.submissionNotice.link && <p><a
        href={props.submissionNotice.link.url}
        target="_blank"
        rel="noopener noreferrer"
      >{props.submissionNotice.link.label}</a></p>}
    </aside>}
    <label className="feedback-redmine-field">最初のコメント
      <textarea
        rows={5}
        maxLength={20_000}
        placeholder="気づいた点をご記入ください"
        value={props.comment}
        onChange={(event) => props.onCommentChange(event.target.value)}
      />
    </label>
    <div className="feedback-redmine-button-row">
      <button type="button" className="feedback-redmine-button-secondary" onClick={props.onClose}>キャンセル</button>
      <button
        type="submit"
        className="feedback-redmine-button-primary"
        disabled={props.submitting || !props.comment.trim() || !props.perspectiveCode}
      >{props.submitting ? "投稿中…" : "Feedbackを送信"}</button>
    </div>
  </form>;
}

function PanelHeader(props: { title: string; closeLabel: string; onClose(): void }) {
  return <header className="feedback-redmine-panel-header">
    <h2>{props.title}</h2>
    <button type="button" className="feedback-redmine-icon-button" aria-label={props.closeLabel} onClick={props.onClose}>×</button>
  </header>;
}

function FeedbackContextMenu(props: { value: ContextMenuState; onClose(): void; onSelect(): void }) {
  const panelRef = useDismissiblePanel<HTMLDivElement>(props.onClose);
  const width = 220;
  const height = 48;
  const margin = 8;
  const left = Math.max(margin, Math.min(props.value.clientX, window.innerWidth - width - margin));
  const top = Math.max(margin, Math.min(props.value.clientY, window.innerHeight - height - margin));
  return <svg className="feedback-redmine-context-menu-layer">
    <foreignObject x={left} y={top} width={width} height={height + 12} className="feedback-redmine-context-menu-host">
      <div
        ref={panelRef}
        className="feedback-redmine-context-menu"
        role="menu"
        aria-label="フィードバックメニュー"
        onContextMenu={(event) => event.preventDefault()}
      >
        <button type="button" role="menuitem" onClick={props.onSelect}>フィードバックを残す</button>
      </div>
    </foreignObject>
  </svg>;
}

export function feedbackLocationMatches(left: FeedbackLocationV1, right: FeedbackLocationV1): boolean {
  return left.pageKey === right.pageKey && left.routeTemplate === right.routeTemplate &&
    equalParameters(left.pathParameters, right.pathParameters) &&
    equalParameters(left.queryParameters ?? {}, right.queryParameters ?? {});
}

export function buildFeedbackThreadUrl(
  location: Pick<Location, "origin" | "pathname">,
  threadId: string
): string {
  const url = new URL(location.pathname || "/", location.origin);
  url.searchParams.set("feedbackThread", threadId);
  return url.toString();
}

function equalParameters(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

function eventFromFeedbackUi(event: Event): boolean {
  return event.composedPath().some((value) => value instanceof Element &&
    (value.matches("[data-feedback-redmine-ui]") || Boolean(value.closest("[data-feedback-redmine-ui]"))));
}

function assertProfileMatchesHost(
  profile: RedmineClientProfileV1,
  context: { applicationKey: string; environmentKey: string; externalWorkspaceKey: string }
): void {
  if (profile.applicationKey !== context.applicationKey || profile.environmentKey !== context.environmentKey ||
    profile.externalWorkspaceKey !== context.externalWorkspaceKey) {
    throw new Error("gateway profileとhost contextが一致しません");
  }
}

function threadVersion(thread: RedmineThreadV1 | null): string {
  if (!thread) return "";
  return `${thread.updatedAt}:${thread.messages?.map((message) => `${message.id}:${message.version}`).join(",") ??
    thread.timeline.map((item) => `${item.journalId}:${item.kind === "reply" ? item.updatedAt : ""}`).join(",")}`;
}

function readState(
  thread: RedmineThreadV1,
  profileId: string,
  principalScopeHash: string,
  followed: boolean
): RedmineFollowStateV1 {
  const journalIds = thread.timeline.map((item) => item.journalId ?? 0);
  const seenJournalIds = [...new Set(journalIds.filter((journalId) => journalId > 0))].slice(-10_000);
  return {
    schemaVersion: "1",
    profileId,
    principalScopeHash,
    threadId: thread.threadId,
    issueId: thread.issueId,
    followed,
    lastSeenJournalId: Math.max(0, ...journalIds),
    seenJournalIds,
    lastSeenIssueUpdatedOn: thread.updatedAt,
    updatedAt: new Date().toISOString()
  };
}

export function targetLabel(target: FeedbackTargetV1): string {
  if (target.kind === "ui-element") return `要素 ${target.elementKey}`;
  if (target.kind === "map-feature") return `地図地物 ${target.featureKey}`;
  if (target.kind === "map-position") return "地図上の位置";
  if (target.kind === "custom") return `カスタム ${target.provider} / ${target.targetKey}`;
  return "画面上の位置";
}

function participantNameKey(profileId: string): string {
  return `feedback.redmine.participant-name.v1:${profileId}`;
}

function readParticipantName(profileId: string): string {
  try { return localStorage.getItem(participantNameKey(profileId))?.slice(0, 100) ?? ""; } catch { return ""; }
}

function writeParticipantName(profileId: string, value: string): void {
  try {
    const normalized = value.trim().slice(0, 100);
    if (normalized) localStorage.setItem(participantNameKey(profileId), normalized);
    else localStorage.removeItem(participantNameKey(profileId));
  } catch {
    // self-reported nameはstorageを利用できない場合でも投稿payloadへ含める。
  }
}
