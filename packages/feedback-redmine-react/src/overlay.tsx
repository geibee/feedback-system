import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from "react";
import {
  canonicalJson,
  countUnreadReplies,
  RedmineFeedbackError,
  sha256Hex,
  type RedmineClientProfileV1,
  type RedmineCapabilitiesV1,
  type RedmineEvidenceMetadata,
  type RedmineFollowStateV1,
  type RedminePendingIntentV1,
  type RedmineThreadFilter,
  type RedmineThreadSort,
  type RedmineThreadSummaryV1,
  type RedmineThreadV1
} from "@feedback/redmine-core";
import type { FeedbackEvidencePayload, FeedbackTargetV1 } from "@feedback/core";
import { resolveDomFeedbackTarget } from "@feedback/react-ui";
import { useRedmineFeedbackRuntime } from "./provider.js";
import { useVisiblePolling } from "./storage.js";
import { ThreadDrawer } from "./thread-drawer.js";
import { ThreadList } from "./thread-list.js";
import { ThreadPins } from "./thread-pins.js";
import { feedbackErrorMessage } from "./error-message.js";

export type RedmineFeedbackOverlayHandle = {
  refresh(): Promise<void>;
  openThread(threadId: string): Promise<void>;
};

export type RedmineFeedbackOverlayProps = {
  onUnavailable?: (error: unknown) => void;
};

export const RedmineFeedbackOverlay = forwardRef<
  RedmineFeedbackOverlayHandle,
  RedmineFeedbackOverlayProps
>(function RedmineFeedbackOverlay(props, ref) {
  const runtime = useRedmineFeedbackRuntime();
  const controller = useMemo(() => new AbortController(), []);
  const [profile, setProfile] = useState<RedmineClientProfileV1 | null>(null);
  const [capabilities, setCapabilities] = useState<RedmineCapabilitiesV1 | null>(null);
  const [principal, setPrincipal] = useState<{ participantId: string } | null>(null);
  const [principalScopeHash, setPrincipalScopeHash] = useState("");
  const [threads, setThreads] = useState<RedmineThreadSummaryV1[]>([]);
  const threadsRef = useRef<RedmineThreadSummaryV1[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [sort, setSort] = useState<RedmineThreadSort>("updated_desc");
  const [filter, setFilter] = useState<RedmineThreadFilter>({});
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedThread, setSelectedThread] = useState<RedmineThreadV1 | null>(null);
  const [followed, setFollowed] = useState(false);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [participantName, setParticipantName] = useState("");
  const [perspectiveCode, setPerspectiveCode] = useState("");
  const [capture, setCapture] = useState<{ payload: FeedbackEvidencePayload; url: string } | null>(null);
  const [captureConsent, setCaptureConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submissionInFlight = useRef(false);
  const [submissionTarget, setSubmissionTarget] = useState<FeedbackTargetV1 | null>(null);
  const [pickingTarget, setPickingTarget] = useState(false);

  useEffect(() => () => controller.abort(), [controller]);
  useEffect(() => () => {
    if (capture) URL.revokeObjectURL(capture.url);
  }, [capture]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      runtime.port.getCapabilities(runtime.profileId, controller.signal),
      runtime.port.getCurrentUser(runtime.profileId, controller.signal)
    ]).then(async ([result, current]) => {
      if (!active) return;
      assertProfileMatchesHost(result.profile, runtime.adapter.getContext());
      const scopeHash = await sha256Hex(new TextEncoder().encode(`${runtime.profileId}\n${current.participantId}`));
      const draft = await runtime.clientState.getDraft(runtime.profileId, scopeHash);
      if (!active) return;
      setProfile(result.profile);
      setCapabilities(result.capabilities);
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
            !(state.seenJournalIds ?? []).includes(message.journalId) && message.author.participantId !== principal.participantId).length
          : countUnreadReplies(
            detail.timeline.flatMap((item) => item.kind === "reply"
              ? [{ id: item.journalId, notes: item.body, authorId: item.author.id }]
              : []),
            state,
            null
          );
      } catch {
        // 個別threadの失敗で一覧表示を壊さない。
      }
    }
    setUnread(count);
  }, [controller.signal, principal, principalScopeHash, runtime]);

  const loadThreads = useCallback(async (cursor: string | undefined, append: boolean) => {
    if (!profile) return;
    const location = runtime.adapter.getLocation();
    if (!location) {
      setThreads([]);
      threadsRef.current = [];
      setNextCursor(null);
      return;
    }
    setLoading(true);
    try {
      const result = await runtime.port.listThreads({
        profileId: runtime.profileId,
        resourceRef: runtime.adapter.getResourceRef(),
        pageKey: location.pageKey,
        sort,
        filter,
        ...(cursor === undefined ? {} : { cursor })
      }, controller.signal);
      const hydrated = [...result.threads];
      for (let start = 0; start < Math.min(hydrated.length, 10); start += 4) {
        const rows = hydrated.slice(start, start + 4);
        const details = await Promise.all(rows.map(async (row) => {
          try {
            return await runtime.port.getThread({
              profileId: runtime.profileId,
              resourceRef: runtime.adapter.getResourceRef(),
              threadId: row.threadId
            }, controller.signal);
          } catch {
            return null;
          }
        }));
        details.forEach((detail, offset) => {
          if (detail) hydrated[start + offset] = { ...hydrated[start + offset]!, latestReply: detail.latestReply };
        });
      }
      const combined = append
        ? [...threadsRef.current.filter((current) => !hydrated.some((next) => next.threadId === current.threadId)), ...hydrated]
        : hydrated;
      threadsRef.current = combined;
      setThreads(combined);
      setNextCursor(result.nextCursor);
      setError(null);
      await refreshUnread(combined);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(feedbackErrorMessage(reason, "一覧"));
        props.onUnavailable?.(reason);
      }
    } finally {
      setLoading(false);
    }
  }, [controller.signal, filter, profile, props.onUnavailable, refreshUnread, runtime, sort]);
  const refresh = useCallback(async () => loadThreads(undefined, false), [loadThreads]);
  const loadMore = useCallback(async () => {
    if (nextCursor && !loading) await loadThreads(nextCursor, true);
  }, [loadThreads, loading, nextCursor]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const refreshSelected = useCallback(async () => {
    if (!selectedThreadId) return;
    try {
      const detail = await runtime.port.getThread({
        profileId: runtime.profileId,
        resourceRef: runtime.adapter.getResourceRef(),
        threadId: selectedThreadId
      }, controller.signal);
      setSelectedThread((current) => threadVersion(current) === threadVersion(detail) ? current : detail);
      setError(null);
      if (principalScopeHash) {
        const current = await runtime.clientState.getFollowState(runtime.profileId, principalScopeHash, detail.threadId);
        const next = readState(detail, runtime.profileId, principalScopeHash, current?.followed ?? false);
        await runtime.clientState.setFollowState(next);
        setFollowed(next.followed);
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(`${feedbackErrorMessage(reason, "詳細")} 最後に取得した内容があれば継続表示します。`);
        props.onUnavailable?.(reason);
      }
    }
  }, [controller.signal, principalScopeHash, props.onUnavailable, runtime, selectedThreadId]);

  useEffect(() => {
    if (profile) void refresh();
  }, [profile, refresh]);
  useEffect(() => {
    if (panelOpen) void refreshRef.current();
    else {
      setThreads((current) => {
        const summaries = current.map((thread) =>
          thread.latestReply === null ? thread : { ...thread, latestReply: null }
        );
        threadsRef.current = summaries;
        return summaries;
      });
    }
  }, [panelOpen]);
  useEffect(() => {
    if (selectedThreadId) {
      setSelectedThread(null);
      void refreshSelected();
    }
  }, [refreshSelected, selectedThreadId]);
  useEffect(() => runtime.adapter.subscribe?.(() => void refresh()), [refresh, runtime.adapter]);
  useVisiblePolling(panelOpen && !selectedThreadId, 15_000, refresh);
  useVisiblePolling(Boolean(selectedThreadId), 15_000, refreshSelected);

  const openThread = useCallback(async (threadId: string) => {
    setPanelOpen(true);
    setSelectedThreadId(threadId);
  }, []);
  useEffect(() => {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get("feedbackThread");
    const fromHash = /(?:^|[&#])feedbackThread=([0-9a-f-]{36})(?:&|$)/iu.exec(url.hash.slice(1))?.[1] ?? null;
    const threadId = fromQuery ?? fromHash;
    if (threadId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(threadId)) {
      void openThread(threadId);
    }
  }, [openThread]);
  useImperativeHandle(ref, () => ({ refresh, openThread }), [openThread, refresh]);

  const captureEvidence = async (target: FeedbackTargetV1) => {
    if (!profile?.capture.enabled || !runtime.adapter.captureEvidence) return;
    const location = runtime.adapter.getLocation();
    if (!location) return;
    const payload = await runtime.adapter.captureEvidence({
      context: runtime.adapter.getContext(),
      location,
      target,
      excludeSelector: "[data-feedback-redmine-ui]",
      maskSelector: "[data-feedback-mask]"
    });
    if (!payload) return;
    if (capture) URL.revokeObjectURL(capture.url);
    setCapture({
      payload,
      url: URL.createObjectURL(new Blob([Uint8Array.from(payload.bytes).buffer], { type: payload.contentType }))
    });
    setCaptureConsent(false);
  };

  const selectTarget = useCallback((clientX: number, clientY: number, action: "pick" | "context-menu") => {
    const element = document.elementFromPoint?.(clientX, clientY) ?? null;
    if (element?.closest("[data-feedback-redmine-ui]")) return;
    const target = runtime.targetResolver?.({ action, element, clientX, clientY }) ??
      resolveDomFeedbackTarget({ element, clientX, clientY });
    setSubmissionTarget(target);
    setPickingTarget(false);
    setPanelOpen(true);
    setCapture(null);
    setCaptureConsent(false);
    if (target) void captureEvidence(target).catch(() => setError("スクリーンショットを取得できませんでした。画像なしで投稿できます。"));
  }, [profile, runtime]);

  useEffect(() => {
    const click = (event: MouseEvent) => {
      if (!pickingTarget) return;
      event.preventDefault();
      event.stopPropagation();
      selectTarget(event.clientX, event.clientY, "pick");
    };
    const contextMenu = (event: MouseEvent) => {
      if (!runtime.contextMenu || (event.target as Element | null)?.closest?.("[data-feedback-redmine-ui]")) return;
      event.preventDefault();
      selectTarget(event.clientX, event.clientY, "context-menu");
    };
    document.addEventListener("click", click, true);
    document.addEventListener("contextmenu", contextMenu, true);
    return () => {
      document.removeEventListener("click", click, true);
      document.removeEventListener("contextmenu", contextMenu, true);
    };
  }, [pickingTarget, runtime.contextMenu, selectTarget]);

  const submit = async () => {
    if (!profile || !principalScopeHash || !comment.trim() || comment.trim().length > 20_000 || !perspectiveCode || submissionInFlight.current) return;
    if (!submissionTarget) return;
    const location = runtime.adapter.getLocation();
    if (!location) return;
    setSubmitting(true);
    submissionInFlight.current = true;
    let pendingIntent: RedminePendingIntentV1 | null = null;
    try {
      const attachedCapture = captureConsent ? capture : null;
      const evidenceSha256 = attachedCapture ? await sha256Hex(attachedCapture.payload.bytes) : null;
      const localHash = await sha256Hex(new TextEncoder().encode(canonicalJson({
        comment: comment.trim(),
        perspectiveCode,
        location,
        evidenceSha256
      })));
      const existing = await runtime.clientState.getPendingIntent(runtime.profileId, principalScopeHash);
      const threadId = existing?.clientDraftHash === localHash ? existing.threadId : crypto.randomUUID();
      const intentId = existing?.clientDraftHash === localHash ? existing.intentId : crypto.randomUUID();
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
        capturedAt: new Date().toISOString(),
        evidence,
        participantName: participantName.trim() || null
      }, attachedCapture?.payload.bytes ?? null, controller.signal);
      await runtime.clientState.setPendingIntent(runtime.profileId, principalScopeHash, null);
      await runtime.clientState.setDraft(runtime.profileId, principalScopeHash, null);
      await runtime.clientState.setFollowState(readState(created, runtime.profileId, principalScopeHash, true));
      setComment("");
      writeParticipantName(runtime.profileId, participantName);
      if (capture) URL.revokeObjectURL(capture.url);
      setCapture(null);
      setCaptureConsent(false);
      await refresh();
      await openThread(created.threadId);
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
    await refreshUnread(threads);
  };

  return <div className={`feedback-redmine-root${pickingTarget ? " is-picking" : ""}`} data-feedback-redmine-ui="true">
    <button
      className="feedback-redmine-launcher"
      type="button"
      aria-label="Feedbackを開く"
      onClick={() => setPanelOpen((open) => !open)}
    >
      Feedback {unread > 0 && <span className="feedback-redmine-badge">{unread > 99 ? "99+" : unread}</span>}
    </button>
    <ThreadPins threads={threads} positionProvider={runtime.pinPositionProvider} onOpen={(threadId) => void openThread(threadId)} />
    {panelOpen && profile && <div className="feedback-redmine-panel">
      <header><h1>{profile.displayName}</h1><p>投稿と返信はこの画面だけで完結します。</p></header>
      {error && <p role="alert">{error}</p>}
      <section aria-label="新しいFeedback" className="feedback-redmine-create">
        <button type="button" onClick={() => setPickingTarget(true)}>
          {pickingTarget ? "フィードバックする場所をクリックしてください" : submissionTarget ? "場所を選び直す" : "場所を選択"}
        </button>
        {submissionTarget && <p className="feedback-redmine-target">選択位置: {targetLabel(submissionTarget)}</p>}
        <label>投稿者名
          <input
            maxLength={100}
            value={participantName}
            onChange={(event) => setParticipantName(event.target.value)}
            onBlur={() => writeParticipantName(runtime.profileId, participantName)}
          />
        </label>
        <label>観点
          <select value={perspectiveCode} onChange={(event) => setPerspectiveCode(event.target.value)}>
            {profile.perspectives.map((perspective) => <option key={perspective.code} value={perspective.code}>{perspective.label}</option>)}
          </select>
        </label>
        <label>最初のコメント
          <textarea
            maxLength={20_000}
            value={comment}
            onChange={(event) => {
              setComment(event.target.value);
              if (principalScopeHash) {
                void runtime.clientState.setDraft(runtime.profileId, principalScopeHash, event.target.value || null);
              }
            }}
          />
        </label>
        {profile.capture.enabled && runtime.adapter.captureEvidence &&
          <button type="button" disabled={!submissionTarget} onClick={() => submissionTarget && void captureEvidence(submissionTarget)}>スクリーンショットを再取得</button>}
        {capture && <div className="feedback-redmine-capture-preview">
          <img src={capture.url} alt="送信前スクリーンショット" />
          <label><input type="checkbox" checked={captureConsent} onChange={(event) => setCaptureConsent(event.target.checked)} />この画像をRedmineへ送信する</label>
        </div>}
        <button type="button" disabled={submitting || !comment.trim() || !submissionTarget} onClick={() => void submit()}>
          {submitting ? "投稿中…" : "Feedbackを送信"}
        </button>
      </section>
      <ThreadList
        profile={profile}
        threads={threads}
        sort={sort}
        filter={filter}
        loading={loading}
        nextCursor={nextCursor}
        onSortChange={setSort}
        onFilterChange={setFilter}
        onOpen={(threadId) => void openThread(threadId)}
        onLoadMore={() => void loadMore()}
      />
    </div>}
    {selectedThreadId && <ThreadDrawer
      thread={selectedThread}
      loading={!selectedThread}
      error={error}
      followed={followed}
      onClose={() => {
        setSelectedThreadId(null);
        setSelectedThread(null);
        setFollowed(false);
      }}
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
  </div>;
});

function assertProfileMatchesHost(
  profile: RedmineClientProfileV1,
  context: { applicationKey: string; environmentKey: string; externalWorkspaceKey: string }
): void {
  if (
    profile.applicationKey !== context.applicationKey ||
    profile.environmentKey !== context.environmentKey ||
    profile.externalWorkspaceKey !== context.externalWorkspaceKey
  ) throw new Error("gateway profileとhost contextが一致しません");
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

function targetLabel(target: FeedbackTargetV1): string {
  if (target.kind === "ui-element") return `要素 ${target.elementKey}`;
  if (target.kind === "map-feature") return `地図地物 ${target.featureKey}`;
  if (target.kind === "map-position") return "地図上の位置";
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
