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
  type RedmineEvidenceMetadata,
  type RedmineFollowStateV1,
  type RedminePendingIntentV1,
  type RedmineThreadFilter,
  type RedmineThreadSort,
  type RedmineThreadSummaryV1,
  type RedmineThreadV1
} from "@feedback/redmine-core";
import type { FeedbackEvidencePayload } from "@feedback/core";
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
  const [principal, setPrincipal] = useState<{ subjectId: string; redmineUserId: number | null } | null>(null);
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
  const [perspectiveCode, setPerspectiveCode] = useState("");
  const [capture, setCapture] = useState<{ payload: FeedbackEvidencePayload; url: string } | null>(null);
  const [captureConsent, setCaptureConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submissionInFlight = useRef(false);
  const submissionTarget = useMemo(() => ({
    schemaVersion: "1" as const,
    kind: "screen-position" as const,
    relativeX: 0.5,
    relativeY: 0.5
  }), []);

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
      const scopeHash = await sha256Hex(new TextEncoder().encode(`${runtime.profileId}\n${current.subjectId}`));
      const draft = await runtime.clientState.getDraft(runtime.profileId, scopeHash);
      if (!active) return;
      setProfile(result.profile);
      setPerspectiveCode(result.profile.perspectives[0]?.code ?? "");
      setPrincipal(current);
      setPrincipalScopeHash(scopeHash);
      setComment(draft ?? "");
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
        count += countUnreadReplies(
          detail.timeline.flatMap((item) => item.kind === "reply"
            ? [{ id: item.journalId, notes: item.body, authorId: item.author.id }]
            : []),
          state,
          principal.redmineUserId
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
  useVisiblePolling(panelOpen && !selectedThreadId, 60_000, refresh);
  useVisiblePolling(Boolean(selectedThreadId), 30_000, refreshSelected);

  const openThread = useCallback(async (threadId: string) => {
    setPanelOpen(true);
    setSelectedThreadId(threadId);
  }, []);
  useImperativeHandle(ref, () => ({ refresh, openThread }), [openThread, refresh]);

  const captureEvidence = async () => {
    if (!profile?.capture.enabled || !runtime.adapter.captureEvidence) return;
    const location = runtime.adapter.getLocation();
    if (!location) return;
    const payload = await runtime.adapter.captureEvidence({
      context: runtime.adapter.getContext(),
      location,
      target: submissionTarget,
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

  const submit = async () => {
    if (!profile || !principalScopeHash || !comment.trim() || comment.trim().length > 20_000 || !perspectiveCode || submissionInFlight.current) return;
    if (capture && !captureConsent) return;
    const location = runtime.adapter.getLocation();
    if (!location) return;
    setSubmitting(true);
    submissionInFlight.current = true;
    let pendingIntent: RedminePendingIntentV1 | null = null;
    try {
      const evidenceSha256 = capture ? await sha256Hex(capture.payload.bytes) : null;
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
      const evidence: RedmineEvidenceMetadata | null = capture ? {
        filename: `feedback-${threadId}.${capture.payload.contentType === "image/png" ? "png" : "webp"}`,
        contentType: capture.payload.contentType,
        byteSize: capture.payload.bytes.byteLength,
        sha256: evidenceSha256!,
        viewportWidth: capture.payload.viewportWidth,
        viewportHeight: capture.payload.viewportHeight,
        pixelRatio: capture.payload.pixelRatio,
        capturedAt: capture.payload.capturedAt
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
        evidence
      }, capture?.payload.bytes ?? null, controller.signal);
      await runtime.clientState.setPendingIntent(runtime.profileId, principalScopeHash, null);
      await runtime.clientState.setDraft(runtime.profileId, principalScopeHash, null);
      await runtime.clientState.setFollowState(readState(created, runtime.profileId, principalScopeHash, true));
      setComment("");
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

  return <div className="feedback-redmine-root" data-feedback-redmine-ui="true">
    <button
      className="feedback-redmine-launcher"
      type="button"
      aria-label="Feedbackを開く"
      onClick={() => setPanelOpen((open) => !open)}
    >
      Feedback {unread > 0 && <span className="feedback-redmine-badge">{unread > 99 ? "99+" : unread}</span>}
    </button>
    <ThreadPins threads={threads} onOpen={(threadId) => void openThread(threadId)} />
    {panelOpen && profile && <div className="feedback-redmine-panel">
      <header><h1>{profile.displayName}</h1><p>Feedbackから送信できるのは最初の投稿だけです。</p></header>
      {error && <p role="alert">{error}</p>}
      <section aria-label="新しいFeedback" className="feedback-redmine-create">
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
          <button type="button" onClick={() => void captureEvidence()}>スクリーンショットを確認</button>}
        {capture && <div className="feedback-redmine-capture-preview">
          <img src={capture.url} alt="送信前スクリーンショット" />
          <label><input type="checkbox" checked={captureConsent} onChange={(event) => setCaptureConsent(event.target.checked)} />この画像をRedmineへ送信する</label>
        </div>}
        <button type="button" disabled={submitting || !comment.trim() || (Boolean(capture) && !captureConsent)} onClick={() => void submit()}>
          {submitting ? "投稿中…" : "最初の投稿をRedmineへ送信"}
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
  return `${thread.updatedAt}:${thread.timeline.map((item) => `${item.journalId}:${item.kind === "reply" ? item.updatedAt : ""}`).join(",")}`;
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
