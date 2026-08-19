import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type FormEvent,
  type ReactNode
} from "react";
import type { components } from "@feedback/contracts";
import { FeedbackTransportError, type FeedbackTransport } from "@feedback/core";

type Schemas = components["schemas"];
type Session = Schemas["FeedbackSessionV1"];
type Thread = Schemas["FeedbackThreadV1"];
type ExportJob = Schemas["FeedbackExportJob"];
type BackupPolicy = Schemas["FeedbackBackupPolicy"];
type BackupPolicyView = Schemas["FeedbackBackupPolicyView"];
type BackupRun = Schemas["FeedbackBackupRun"];
type Member = Schemas["FeedbackWorkspaceMember"];
type Delivery = Schemas["FeedbackNotificationDelivery"];
type ConnectorType = Schemas["FeedbackConnectorType"];
type NotificationConnector = Schemas["FeedbackNotificationConnector"];
type ManifestRoute = Schemas["FeedbackApplicationManifestV1"]["routes"][number];
type SessionScope = Session["scopes"][number];
type SessionPerspective = Session["perspectives"][number];

type EvidencePreview = {
  threadId: string;
  displayNumber: number;
  perspectiveLabel: string;
  status: "loading" | "ready" | "error";
  url: string | null;
  error: string | null;
};

type ExportFormat = "csv" | "xlsx" | "evidence-package";

type ActiveExport = {
  job: ExportJob;
  format: ExportFormat;
  pollingError: string | null;
  pollingFailureCount: number;
  downloadError: string | null;
  downloadState: "idle" | "downloading" | "succeeded" | "failed";
};

const perspectiveDefinitions = [
  ["BUSINESS_FLOW", "業務フロー", "一連の業務が想定どおり進められるか"],
  ["INFORMATION", "項目・情報の過不足", "表示・入力する情報が適切か"],
  ["USABILITY", "操作性", "操作の分かりやすさや手数"],
  ["MAP_OPERATION", "地図操作", "地図と業務情報の連動や操作"],
  ["UI_DESIGN", "デザイン・配色", "画面の見た目、配色、文言"],
  ["PERFORMANCE", "性能", "表示や検索の速度"],
  ["AUTHORIZATION", "権限制御", "ロールごとの参照・操作可否"],
  ["ERROR_HANDLING", "エラー処理", "入力誤りや例外時の挙動"]
] as const;

export type FeedbackAdminConsoleProps = {
  transport: FeedbackTransport;
  applicationKey: string;
  environmentKey: string;
  externalWorkspaceKey: string;
  locale?: string;
  timezone?: string;
  className?: string;
  openExternal?: (url: string) => void;
  initialAction?: "create-review";
};

type Tab = "sessions" | "manifest" | "retention" | "memberships" | "notifications";

/** Web GISへ依存せずFeedback Service v1だけで全レビュー管理を行うconsole。 */
export function FeedbackAdminConsole({
  transport,
  applicationKey,
  environmentKey,
  externalWorkspaceKey,
  locale = "ja-JP",
  timezone = "Asia/Tokyo",
  className,
  initialAction,
  openExternal
}: FeedbackAdminConsoleProps) {
  const [tab, setTab] = useState<Tab>("sessions");
  const [error, setError] = useState<string | null>(null);
  const scopeQuery = useMemo(() => query({ applicationKey, environmentKey, externalWorkspaceKey }), [
    applicationKey,
    environmentKey,
    externalWorkspaceKey
  ]);
  return (
    <section className={`feedback-admin${className ? ` ${className}` : ""}`}>
      <header className="feedback-admin-hero"><p className="eyebrow">Feedback workspace</p><h1>フィードバック管理</h1><p>レビューの受付から対応状況、通知、保存設定までをまとめて管理します。</p><p className="feedback-admin-scope">{applicationKey} / {environmentKey} / {externalWorkspaceKey}</p></header>
      <nav aria-label="管理対象">
        {([
          ["sessions", "レビュー"],
          ["manifest", "アプリ設定"],
          ["retention", "保存・エクスポート"],
          ["memberships", "メンバー"],
          ["notifications", "通知"]
        ] as const).map(([value, label]) => (
          <button type="button" key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{label}</button>
        ))}
      </nav>
      {error ? <p className="feedback-admin-error" role="alert">{error}</p> : null}
      {tab === "sessions" ? (
        <SessionAdministration
          transport={transport}
          scopeQuery={scopeQuery}
          applicationKey={applicationKey}
          environmentKey={environmentKey}
          externalWorkspaceKey={externalWorkspaceKey}
          openExternal={openExternal}
          startCreate={initialAction === "create-review"}
          onError={setError}
        />
      ) : null}
      {tab === "manifest" ? (
        <ManifestAdministration transport={transport} applicationKey={applicationKey} onError={setError} />
      ) : null}
      {tab === "retention" ? (
        <RetentionAndExport
          transport={transport}
          scopeQuery={scopeQuery}
          applicationKey={applicationKey}
          environmentKey={environmentKey}
          externalWorkspaceKey={externalWorkspaceKey}
          locale={locale}
          timezone={timezone}
          onError={setError}
        />
      ) : null}
      {tab === "memberships" ? (
        <MembershipAdministration transport={transport} scopeQuery={scopeQuery} onError={setError} />
      ) : null}
      {tab === "notifications" ? (
        <NotificationAdministration transport={transport} scopeQuery={scopeQuery} onError={setError} />
      ) : null}
    </section>
  );
}

function SessionAdministration({
  transport,
  scopeQuery,
  applicationKey,
  environmentKey,
  externalWorkspaceKey,
  openExternal,
  startCreate,
  onError
}: {
  transport: FeedbackTransport;
  scopeQuery: string;
  applicationKey: string;
  environmentKey: string;
  externalWorkspaceKey: string;
  openExternal?: (url: string) => void;
  startCreate: boolean;
  onError(error: string | null): void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [sessionSearch, setSessionSearch] = useState("");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [threadSort, setThreadSort] = useState<"updated_desc" | "created_desc" | "created_asc">("updated_desc");
  const [threadStatus, setThreadStatus] = useState<"" | "open" | "resolved">("");
  const [threadPerspective, setThreadPerspective] = useState("");
  const [threadEvidence, setThreadEvidence] = useState<"" | "with" | "without">("");
  const [threadAssignee, setThreadAssignee] = useState("");
  const [threadPriority, setThreadPriority] = useState("");
  const [threadLabel, setThreadLabel] = useState("");
  const [threadSearch, setThreadSearch] = useState("");
  const [title, setTitle] = useState("");
  const [manifestVersion, setManifestVersion] = useState("1");
  const [scopes, setScopes] = useState("[]");
  const [perspectives, setPerspectives] = useState(() => startCreate
    ? JSON.stringify([{ code: "BUSINESS_FLOW", label: "業務フロー", status: "active", guidance: null }], null, 2)
    : "[]");
  const [createOpen, setCreateOpen] = useState(startCreate);
  const [editOpen, setEditOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [createStatus, setCreateStatus] = useState<Session["status"]>(startCreate ? "open" : "draft");
  const [outOfScopePosting, setOutOfScopePosting] = useState<Session["outOfScopePosting"]>("warn");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [manifestRoutes, setManifestRoutes] = useState<ManifestRoute[]>([]);
  const [evidence, setEvidence] = useState<EvidencePreview | null>(null);
  const evidenceGeneration = useRef(0);
  const evidenceUrl = useRef<string | null>(null);
  const releaseEvidenceUrl = useCallback(() => {
    if (!evidenceUrl.current) return;
    URL.revokeObjectURL(evidenceUrl.current);
    evidenceUrl.current = null;
  }, []);
  const closeEvidence = useCallback(() => {
    evidenceGeneration.current += 1;
    releaseEvidenceUrl();
    setEvidence(null);
  }, [releaseEvidenceUrl]);
  const refresh = useCallback(async () => {
    try {
		const items = await requestAllPages<Session>(transport, `/sessions?${scopeQuery}`);
		setSessions(items);
		setSelectedId((current) => items.some((item) => item.id === current)
        ? current
			: items.find((item) => item.status === "open")?.id ?? items[0]?.id ?? "");
      onError(null);
    } catch (caught) { onError(messageOf(caught)); }
    finally { setLoading(false); }
  }, [onError, scopeQuery, transport]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    void transport.request<Schemas["FeedbackApplicationManifestV1"]>(
      `/applications/${encodeURIComponent(applicationKey)}/manifest`
    ).then(
      (resource) => {
        setManifestVersion(resource.value.manifestVersion);
        setManifestRoutes(resource.value.routes);
        setScopes((current) => parseScopeDraft(current).length > 0 ? current : JSON.stringify(resource.value.routes.map((route) => ({ pageKey: route.pageKey, routeTemplate: route.template, reviewable: true })), null, 2));
      },
      (caught) => onError(messageOf(caught))
    );
  }, [applicationKey, onError, transport]);
	useEffect(() => {
		void transport.request<Member[]>(`/memberships?${scopeQuery}`).then(
			(resource) => setMembers(resource.value),
			(caught) => onError(messageOf(caught))
		);
	}, [onError, scopeQuery, transport]);
	const refreshThreads = useCallback(async () => {
    if (!selectedId) { setThreads([]); return; }
		try {
			const sortQuery = threadSort === "updated_desc" ? "" : `?sort=${threadSort}`;
			setThreads(await requestAllPages<Thread>(transport, `/sessions/${selectedId}/threads${sortQuery}`));
		} catch (caught) { onError(messageOf(caught)); }
	}, [onError, selectedId, threadSort, transport]);
	useEffect(() => { void refreshThreads(); }, [refreshThreads]);
  useEffect(() => { closeEvidence(); }, [closeEvidence, selectedId]);
  useEffect(() => {
    if (!evidence) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeEvidence();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeEvidence, evidence]);
  useEffect(() => () => {
    evidenceGeneration.current += 1;
    releaseEvidenceUrl();
  }, [releaseEvidenceUrl]);
  const selected = sessions.find((session) => session.id === selectedId);
  const visibleSessions = sessions.filter((session) => session.title.toLowerCase().includes(sessionSearch.toLowerCase()));
  const visibleThreads = threads.filter((thread) => {
    if (threadStatus && thread.status !== threadStatus) return false;
    if (threadPerspective && thread.perspectiveCode !== threadPerspective) return false;
    if (threadEvidence === "with" && !thread.evidenceAvailable) return false;
    if (threadEvidence === "without" && thread.evidenceAvailable) return false;
    if (threadAssignee && thread.assignee?.userId !== threadAssignee) return false;
    if (threadPriority && thread.priority !== threadPriority) return false;
    if (threadLabel && !thread.labels?.some((label) => label.toLowerCase().includes(threadLabel.toLowerCase()))) return false;
    if (threadSearch && !thread.messages.some((message) => message.body.toLowerCase().includes(threadSearch.toLowerCase()))) return false;
    return true;
  });

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setNotice(null);
    try {
      const requestedScopes = normalizeScopePerspectives(parseScopeDraft(scopes), parsePerspectiveDraft(perspectives));
      const requestedPerspectives = parsePerspectiveDraft(perspectives);
      if (requestedScopes.length === 0) throw new Error("レビュー対象の画面を1つ以上選択してください");
      if (createStatus === "open" && !requestedPerspectives.some((item) => item.status === "active")) throw new Error("受付中にするには、レビュー観点を1つ以上「今回確認」にしてください");
      if (startAt && endAt && new Date(endAt) < new Date(startAt)) throw new Error("終了日時は開始日時以降にしてください");
      await transport.request<Session>("/sessions", {
        method: "POST",
        idempotencyKey: idempotencyKey(),
        body: {
          applicationKey,
          environmentKey,
          externalWorkspaceKey,
          manifestVersion,
          title,
          description: description.trim() || null,
          status: createStatus,
          outOfScopePosting,
          startAt: dateTimeToISO(startAt),
          endAt: dateTimeToISO(endAt),
          scopes: requestedScopes,
          perspectives: requestedPerspectives
        }
      });
      setTitle("");
      setDescription("");
      setCreateOpen(false);
      await refresh();
      setNotice("レビューセッションを作成しました");
    } catch (caught) { onError(messageOf(caught)); }
    finally { setBusy(false); }
  };
  const saveSelected = async () => {
    if (!selected) return;
    setBusy(true); setNotice(null);
    try {
      await transport.request<Session>(`/sessions/${selected.id}`, {
        method: "PATCH",
        ifMatch: versionEtag(selected.version),
        body: {
          title: selected.title,
          description: selected.description,
          status: selected.status,
          outOfScopePosting: selected.outOfScopePosting,
          startAt: selected.startAt,
          endAt: selected.endAt,
          scopes: normalizeScopePerspectives(selected.scopes, selected.perspectives),
          perspectives: selected.perspectives
        }
      });
      setEditOpen(false);
      await refresh();
      setNotice("レビューセッションを更新しました");
    } catch (caught) { onError(messageOf(caught)); }
    finally { setBusy(false); }
  };
  const patchSessionState = (patch: Partial<Session>) => {
    setSessions((current) => current.map((session) => session.id === selectedId ? { ...session, ...patch } : session));
  };
  const selectedScopes = parseScopeDraft(scopes);
  const draftPerspectives = parsePerspectiveDraft(perspectives);
  const updateDraftPerspective = (code: string, label: string, status: string, guidance = "") => {
    const retained = draftPerspectives.filter((item) => item.code !== code);
    const next = status ? [...retained, { code, label, status, guidance: guidance || null }] : retained;
    setPerspectives(JSON.stringify(next, null, 2));
    setScopes(JSON.stringify(reconcileScopePerspectiveCodes(selectedScopes, next as SessionPerspective[]), null, 2));
  };
  const toggleManifestRoute = (route: ManifestRoute, checked: boolean) => {
    const retained = selectedScopes.filter((scope) => scope.pageKey !== route.pageKey);
    const next = checked
      ? [...retained, {
        pageKey: route.pageKey,
        routeTemplate: route.template,
        reviewable: true,
        perspectiveCodes: activePerspectiveCodes(draftPerspectives)
      }]
      : retained;
    setScopes(JSON.stringify(next, null, 2));
  };
  const toggleDraftRoutePerspective = (pageKey: string, code: string, checked: boolean) => {
    const next = selectedScopes.map((scope) => scope.pageKey === pageKey
      ? withToggledPerspective(scope, draftPerspectives, code, checked)
      : scope);
    setScopes(JSON.stringify(next, null, 2));
  };
  const toggleSelectedRoute = (route: ManifestRoute, checked: boolean) => {
    if (!selected) return;
    const retained = selected.scopes.filter((scope) => scope.pageKey !== route.pageKey);
    const next = checked
      ? [...retained, {
        pageKey: route.pageKey,
        routeTemplate: route.template,
        reviewable: true,
        perspectiveCodes: activePerspectiveCodes(selected.perspectives)
      }]
      : retained;
    patchSessionState({ scopes: next });
  };
  const toggleSelectedRoutePerspective = (pageKey: string, code: string, checked: boolean) => {
    if (!selected) return;
    patchSessionState({
      scopes: selected.scopes.map((scope) => scope.pageKey === pageKey
        ? withToggledPerspective(scope, selected.perspectives, code, checked)
        : scope)
    });
  };
  const updateSelectedPerspective = (code: string, label: string, status: string, guidance = "") => {
    if (!selected) return;
    const retained = selected.perspectives.filter((item) => item.code !== code);
    const next = status ? [...retained, { code, label, status, guidance: guidance || null }] : retained;
    const typedNext = next as Session["perspectives"];
    patchSessionState({
      perspectives: typedNext,
      scopes: reconcileScopePerspectiveCodes(selected.scopes, typedNext)
    });
  };
  const toggleThread = async (thread: Thread) => {
    try {
      await transport.request(`/threads/${thread.id}/status`, {
        method: "PATCH",
        ifMatch: versionEtag(thread.version),
        body: { status: thread.status === "open" ? "resolved" : "open" }
      });
      await refreshThreads();
      setNotice(thread.status === "open" ? "フィードバックを対応済みにしました" : "フィードバックを再オープンしました");
    } catch (caught) { onError(messageOf(caught)); }
  };
  const showEvidence = async (thread: Thread) => {
    const generation = evidenceGeneration.current + 1;
    evidenceGeneration.current = generation;
    releaseEvidenceUrl();
    const preview = {
      threadId: thread.id,
      displayNumber: thread.displayNumber,
      perspectiveLabel: perspectiveDisplayLabel(thread.perspectiveCode, selected?.perspectives)
    };
    setEvidence({ ...preview, status: "loading", url: null, error: null });
    try {
      const binary = await transport.requestBinary(`/threads/${thread.id}/evidence`);
      if (generation !== evidenceGeneration.current) return;
      const url = URL.createObjectURL(new Blob([binary.bytes.slice().buffer as ArrayBuffer], { type: binary.contentType }));
      evidenceUrl.current = url;
      setEvidence({ ...preview, status: "ready", url, error: null });
    } catch (caught) {
      if (generation !== evidenceGeneration.current) return;
      setEvidence({ ...preview, status: "error", url: null, error: messageOf(caught) });
    }
  };
  const openThread = async (threadId: string) => {
    const pendingWindow = openExternal ? null : openPendingWindow();
    try {
      const resource = await transport.request<Schemas["FeedbackDeepLink"]>(`/threads/${threadId}/deep-link`);
      const target = directThreadLink(resource.value.url, threadId);
      if (openExternal) openExternal(target);
      else if (pendingWindow) pendingWindow.location.replace(target);
      else window.location.assign(target);
    } catch (caught) {
      pendingWindow?.close();
      onError(messageOf(caught));
    }
  };

  return (
    <div className="feedback-admin-review-layout">
      <aside className="feedback-admin-card feedback-admin-session-sidebar">
        <div className="feedback-admin-sidebar-heading"><h2>レビューセッション</h2><button type="button" onClick={() => setCreateOpen(true)}>新規作成</button></div>
        <label>セッションを検索<input type="search" placeholder="タイトルを検索" value={sessionSearch} onChange={(event) => setSessionSearch(event.target.value)} /></label>
        {loading ? <p className="feedback-admin-help">読み込んでいます...</p> : null}
        <ul className="feedback-admin-session-list">{visibleSessions.map((session) => <li key={session.id} data-session-title={session.title.toLowerCase()}><button type="button" className={session.id === selectedId ? "selected" : ""} onClick={() => { closeEvidence(); setSelectedId(session.id); }}><strong>{session.title}</strong><span>{sessionStatusLabel(session.status)}</span></button></li>)}</ul>
        {!loading && visibleSessions.length === 0 ? <p className="feedback-admin-help">{sessionSearch ? "条件に一致するセッションはありません。" : "レビューセッションはまだありません。"}</p> : null}
      </aside>
      <div className="feedback-admin-review-main">
      {notice ? <p className="feedback-admin-notice" role="status">{notice}</p> : null}
      <div className="feedback-admin-card feedback-admin-card-wide">
        {selected ? <>
          <div className="feedback-admin-session-summary"><div><p className="eyebrow">レビュー管理</p><h2>{selected.title}</h2><p>{selected.description || "説明はありません"}</p></div><button type="button" onClick={() => setEditOpen(true)}>編集</button></div>
          <dl className="feedback-admin-summary"><div><dt>状態</dt><dd>{sessionStatusLabel(selected.status)}</dd></div><div><dt>対象画面</dt><dd>{selected.scopes.length}件</dd></div><div><dt>観点</dt><dd>{selected.perspectives.length}件</dd></div><div><dt>更新日時</dt><dd>{new Date(selected.updatedAt).toLocaleString("ja-JP")}</dd></div></dl>
        </> : <p className="feedback-admin-help">左の一覧からレビューセッションを選択するか、新規作成してください。</p>}
      </div>
      <div className="feedback-admin-card feedback-admin-card-wide">
        <h2>スレッドと証跡</h2>
        <dl className="feedback-admin-summary feedback-admin-thread-summary"><div><dt>未解決</dt><dd>{threads.filter((thread) => thread.status === "open").length}件</dd></div><div><dt>解決済み</dt><dd>{threads.filter((thread) => thread.status === "resolved").length}件</dd></div><div><dt>証跡あり</dt><dd>{threads.filter((thread) => thread.evidenceAvailable).length}件</dd></div></dl>
        <form className="feedback-admin-thread-filters" onSubmit={(event) => event.preventDefault()}>
          <label>並べ替え<select value={threadSort} onChange={(event) => setThreadSort(event.target.value as typeof threadSort)}><option value="updated_desc">最近更新された順</option><option value="created_desc">新しい投稿順</option><option value="created_asc">古い投稿順</option></select></label>
          <label>状態<select value={threadStatus} onChange={(event) => setThreadStatus(event.target.value as typeof threadStatus)}><option value="">すべて</option><option value="open">未解決</option><option value="resolved">解決済み</option></select></label>
          <label>観点<select value={threadPerspective} onChange={(event) => setThreadPerspective(event.target.value)}><option value="">すべて</option>{selected?.perspectives.map((perspective) => <option key={perspective.code} value={perspective.code}>{perspective.label ?? perspective.code}</option>)}</select></label>
          <label>担当者<select value={threadAssignee} onChange={(event) => setThreadAssignee(event.target.value)}><option value="">すべて</option>{members.map((member) => <option key={member.userId} value={member.userId}>{member.displayName ?? member.subject}</option>)}</select></label>
          <label>優先度<select value={threadPriority} onChange={(event) => setThreadPriority(event.target.value)}><option value="">すべて</option><option value="critical">緊急</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label>
          <label>ラベル<input type="search" placeholder="ラベルを検索" value={threadLabel} onChange={(event) => setThreadLabel(event.target.value)} /></label>
          <label>証跡<select value={threadEvidence} onChange={(event) => setThreadEvidence(event.target.value as typeof threadEvidence)}><option value="">すべて</option><option value="with">証跡あり</option><option value="without">証跡なし</option></select></label>
          <label>コメント本文<input type="search" placeholder="コメントを検索" value={threadSearch} onChange={(event) => setThreadSearch(event.target.value)} /></label>
        </form>
        {visibleThreads.map((thread) => {
          const firstMessage = thread.messages[0];
          const latestMessage = thread.messages[thread.messages.length - 1];
          return <article className="feedback-admin-thread" key={thread.id}>
          <h3>#{thread.displayNumber} {perspectiveDisplayLabel(thread.perspectiveCode, selected?.perspectives)}</h3>
          {firstMessage ? <div className="feedback-admin-thread-message is-initial"><strong>最初のコメント</strong><p>{firstMessage.body}</p><small>{participantLabel(firstMessage.author)} / {new Date(firstMessage.createdAt).toLocaleString("ja-JP")}</small><AdminReactionButtons transport={transport} message={firstMessage} onChange={refreshThreads} onError={onError} /></div> : null}
          {latestMessage && latestMessage.id !== firstMessage?.id ? <div className="feedback-admin-thread-message is-latest"><strong>最新の返信</strong><p>{latestMessage.body}</p><small>{participantLabel(latestMessage.author)} / {new Date(latestMessage.createdAt).toLocaleString("ja-JP")}</small><AdminReactionButtons transport={transport} message={latestMessage} onChange={refreshThreads} onError={onError} /></div> : null}
          <ThreadTriageControls transport={transport} thread={thread} members={members} onSaved={refreshThreads} onError={onError} />
          <div className="feedback-admin-actions">
            <button type="button" onClick={() => void openThread(thread.id)}>対象アプリでスレッドを開く</button>
            <button type="button" onClick={() => void toggleThread(thread)}>{thread.status === "open" ? "対応済みにする" : "再オープン"}</button>
            {thread.evidenceAvailable ? <button type="button" onClick={() => void showEvidence(thread)}>証跡</button> : null}
          </div>
        </article>;
        })}
        {visibleThreads.length === 0 ? <p className="feedback-admin-help">条件に一致するフィードバックはありません。</p> : null}
      </div>
      </div>
      {evidence ? <div className="feedback-admin-dialog-backdrop" onClick={(event) => {
        if (event.target === event.currentTarget) closeEvidence();
      }}><section className="feedback-admin-dialog feedback-admin-evidence-dialog" role="dialog" aria-modal="true" aria-label={`証跡 #${evidence.displayNumber}`}><header><div><p className="eyebrow">スレッド #{evidence.displayNumber}</p><h2>証跡</h2><p>観点: {evidence.perspectiveLabel}</p></div><button type="button" aria-label="証跡を閉じる" onClick={closeEvidence}>×</button></header><div className="feedback-admin-evidence-body">
        {evidence.status === "loading" ? <p className="feedback-admin-help" role="status">証跡を読み込んでいます...</p> : null}
        {evidence.status === "error" ? <div><p className="feedback-admin-error" role="alert">証跡を読み込めませんでした: {evidence.error}</p><button type="button" onClick={() => {
          const thread = threads.find((item) => item.id === evidence.threadId);
          if (thread) void showEvidence(thread);
        }}>再試行</button></div> : null}
        {evidence.status === "ready" && evidence.url ? <img src={evidence.url} alt={`スレッド #${evidence.displayNumber} の証跡`} /> : null}
      </div></section></div> : null}
      {createOpen ? <div className="feedback-admin-dialog-backdrop"><section className="feedback-admin-dialog" role="dialog" aria-modal="true" aria-label="レビューセッションの作成"><header><div><p className="eyebrow">レビュー管理</p><h2>レビューセッションを作成</h2></div><button type="button" aria-label="閉じる" onClick={() => setCreateOpen(false)}>×</button></header><form className="feedback-admin-session-form" onSubmit={(event) => void create(event)}>
        <label className="wide">タイトル<input autoFocus required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} /></label><label className="wide">説明<textarea rows={3} maxLength={5000} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <label>状態<select value={createStatus} onChange={(event) => setCreateStatus(event.target.value as Session["status"])}><option value="draft">下書き</option><option value="open">受付中</option><option value="closed">終了</option></select></label><label>対象外画面からの投稿<select value={outOfScopePosting} onChange={(event) => setOutOfScopePosting(event.target.value as Session["outOfScopePosting"])}><option value="warn">警告して許可</option><option value="allow">許可</option><option value="deny">禁止</option></select></label><label>開始日時<input type="datetime-local" value={startAt} onChange={(event) => setStartAt(event.target.value)} /></label><label>終了日時<input type="datetime-local" value={endAt} onChange={(event) => setEndAt(event.target.value)} /></label>
        <fieldset className="wide"><legend>レビュー観点</legend><p>今回のレビューで各観点をどう扱うか選択してください。</p><PerspectiveEditor values={draftPerspectives} onChange={updateDraftPerspective} /></fieldset>
        <fieldset className="wide"><legend>対象画面と確認観点</legend><p>画面を選び、その画面で確認してほしい観点を指定してください。</p><div className="feedback-admin-selection-actions"><span>{selectedScopes.length} / {manifestRoutes.length} 画面を選択中</span><button type="button" onClick={() => setScopes(JSON.stringify(manifestRoutes.map((route) => ({ pageKey: route.pageKey, routeTemplate: route.template, reviewable: true, perspectiveCodes: activePerspectiveCodes(draftPerspectives) })), null, 2))}>すべて選択</button><button type="button" onClick={() => setScopes("[]")}>すべて解除</button></div><RouteSelector routes={manifestRoutes} selected={selectedScopes} perspectives={draftPerspectives} onToggle={toggleManifestRoute} onTogglePerspective={toggleDraftRoutePerspective} /></fieldset>
        <footer className="wide"><button type="button" disabled={busy} onClick={() => setCreateOpen(false)}>キャンセル</button><button type="submit" disabled={busy}>{busy ? "保存中..." : "セッションを作成"}</button></footer>
      </form></section></div> : null}
      {editOpen && selected ? <div className="feedback-admin-dialog-backdrop"><section className="feedback-admin-dialog" role="dialog" aria-modal="true" aria-label="レビューセッションの編集"><header><div><p className="eyebrow">レビュー管理</p><h2>レビューセッションを編集</h2></div><button type="button" aria-label="閉じる" onClick={() => { setEditOpen(false); void refresh(); }}>×</button></header><form className="feedback-admin-session-form" onSubmit={(event) => { event.preventDefault(); void saveSelected(); }}>
        <label className="wide">タイトル<input autoFocus required maxLength={200} value={selected.title} onChange={(event) => patchSessionState({ title: event.target.value })} /></label><label className="wide">説明<textarea rows={3} maxLength={5000} value={selected.description ?? ""} onChange={(event) => patchSessionState({ description: event.target.value || null })} /></label>
        <label>状態<select value={selected.status} onChange={(event) => patchSessionState({ status: event.target.value as Session["status"] })}><option value="draft">下書き</option><option value="open">受付中</option><option value="closed">終了</option></select></label><label>対象外画面からの投稿<select value={selected.outOfScopePosting} onChange={(event) => patchSessionState({ outOfScopePosting: event.target.value as Session["outOfScopePosting"] })}><option value="warn">警告して許可</option><option value="allow">許可</option><option value="deny">禁止</option></select></label><label>開始日時<input type="datetime-local" value={dateTimeLocal(selected.startAt)} onChange={(event) => patchSessionState({ startAt: dateTimeToISO(event.target.value) })} /></label><label>終了日時<input type="datetime-local" value={dateTimeLocal(selected.endAt)} onChange={(event) => patchSessionState({ endAt: dateTimeToISO(event.target.value) })} /></label>
        <fieldset className="wide"><legend>レビュー観点</legend><PerspectiveEditor values={selected.perspectives} onChange={updateSelectedPerspective} /></fieldset><fieldset className="wide"><legend>対象画面と確認観点</legend><p>画面ごとに、利用者へ表示する確認観点を選択してください。</p><div className="feedback-admin-selection-actions"><span>{selected.scopes.length} / {manifestRoutes.length} 画面を選択中</span><button type="button" onClick={() => patchSessionState({ scopes: manifestRoutes.map((route) => ({ pageKey: route.pageKey, routeTemplate: route.template, reviewable: true, perspectiveCodes: activePerspectiveCodes(selected.perspectives) })) })}>すべて選択</button><button type="button" onClick={() => patchSessionState({ scopes: [] })}>すべて解除</button></div><RouteSelector routes={manifestRoutes} selected={selected.scopes} perspectives={selected.perspectives} onToggle={toggleSelectedRoute} onTogglePerspective={toggleSelectedRoutePerspective} /></fieldset>
        <footer className="wide"><button type="button" disabled={busy} onClick={() => { setEditOpen(false); void refresh(); }}>キャンセル</button><button type="submit" disabled={busy}>{busy ? "保存中..." : "変更を保存"}</button></footer>
      </form></section></div> : null}
    </div>
  );
}

const reactionDefinitions = [
  ["thumbs_up", "👍"],
  ["check", "✅"],
  ["eyes", "👀"],
  ["question", "❓"]
] as const;

function AdminReactionButtons({ transport, message, onChange, onError }: {
  transport: FeedbackTransport;
  message: Schemas["FeedbackMessageV1"];
  onChange(): Promise<void>;
  onError(error: string | null): void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  return <div className="feedback-admin-reactions" aria-label="コメントへのリアクション">{reactionDefinitions.map(([key, emoji]) => {
    const summary = message.reactions?.find((item) => item.reaction === key);
    return <button key={key} type="button" className={summary?.reactedByMe ? "selected" : ""} disabled={busy === key}
      aria-pressed={summary?.reactedByMe ?? false} onClick={() => {
        setBusy(key);
        void transport.request(`/messages/${message.id}/reactions/${key}`, {
          method: summary?.reactedByMe ? "DELETE" : "PUT"
        }).then(() => {
          onError(null);
          return onChange();
        }).catch((caught) => onError(messageOf(caught))).finally(() => setBusy(null));
      }}>{emoji}{summary ? ` ${summary.count}` : ""}</button>;
  })}</div>;
}

function ThreadTriageControls({ transport, thread, members, onSaved, onError }: {
  transport: FeedbackTransport;
  thread: Thread;
  members: Member[];
  onSaved(): Promise<void>;
  onError(error: string | null): void;
}) {
  const [assignee, setAssignee] = useState(thread.assignee?.userId ?? "");
  const [priority, setPriority] = useState(thread.priority ?? "");
  const [labels, setLabels] = useState((thread.labels ?? []).join(", "));
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setAssignee(thread.assignee?.userId ?? "");
    setPriority(thread.priority ?? "");
    setLabels((thread.labels ?? []).join(", "));
  }, [thread.assignee?.userId, thread.labels, thread.priority]);
  const save = async () => {
    setSaving(true);
    try {
      await transport.request(`/threads/${thread.id}/triage`, {
        method: "PATCH",
        ifMatch: versionEtag(thread.version),
        body: {
          assigneeUserId: assignee || null,
          priority: priority || null,
          labels: labels.split(",").map((value) => value.trim()).filter(Boolean)
        }
      });
      onError(null);
      await onSaved();
    } catch (caught) { onError(messageOf(caught)); }
    finally { setSaving(false); }
  };
  return <div className="feedback-admin-triage">
    <label>担当者<select value={assignee} onChange={(event) => setAssignee(event.target.value)}><option value="">未設定</option>{members.map((member) => <option key={member.userId} value={member.userId}>{member.displayName ?? member.subject}</option>)}</select></label>
    <label>優先度<select value={priority ?? ""} onChange={(event) => setPriority(event.target.value as typeof priority)}><option value="">未設定</option><option value="critical">緊急</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label>
    <label>ラベル<input value={labels} placeholder="例: UI, 要確認" onChange={(event) => setLabels(event.target.value)} /></label>
    <button type="button" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "トリアージを保存"}</button>
  </div>;
}

function participantLabel(participant: Schemas["FeedbackParticipant"]): string {
  return participant.participantName ?? participant.displayName ?? participant.principalId;
}

async function requestAllPages<T>(transport: FeedbackTransport, path: string): Promise<T[]> {
  const items: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const separator = path.includes("?") ? "&" : "?";
    const resource: { value: { items: T[]; nextCursor?: string | null } } = await transport.request<{ items: T[]; nextCursor?: string | null }>(
      cursor ? `${path}${separator}cursor=${encodeURIComponent(cursor)}` : path
    );
    items.push(...resource.value.items);
    cursor = resource.value.nextCursor ?? null;
    if (cursor && cursors.has(cursor)) throw new Error("一覧のcursorが循環しています");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return items;
}

function PerspectiveEditor({ values, onChange }: {
  values: Array<{ code: string; label: string; status: unknown; guidance?: string | null }>;
  onChange(code: string, label: string, status: string, guidance?: string): void;
}) {
  const known = new Set(perspectiveDefinitions.map(([code]) => code));
  const definitions = [
    ...perspectiveDefinitions,
    ...values.filter((value) => !known.has(value.code as typeof perspectiveDefinitions[number][0])).map((value) => [value.code, value.label, "以前の設定から引き継いだ観点"] as const)
  ];
  return <div className="feedback-admin-perspective-list">{definitions.map(([code, label, help]) => {
    const current = values.find((value) => value.code === code);
    const status = typeof current?.status === "string" ? current.status : "";
    return <div className="feedback-admin-perspective-row" key={code}><span><strong>{label}</strong><small>{help}</small></span><label>扱い<select value={status} onChange={(event) => onChange(code, label, event.target.value, current?.guidance ?? "")}><option value="">未使用</option><option value="active">今回確認</option><option value="future">今後確認</option><option value="out-of-scope">今回対象外</option></select></label><label>補足<input disabled={!status} placeholder="利用者に見せる補足" value={current?.guidance ?? ""} onChange={(event) => onChange(code, label, status, event.target.value)} /></label></div>;
  })}</div>;
}

function RouteSelector({ routes, selected, perspectives, onToggle, onTogglePerspective }: {
  routes: ManifestRoute[];
  selected: SessionScope[];
  perspectives: SessionPerspective[];
  onToggle(route: ManifestRoute, checked: boolean): void;
  onTogglePerspective(pageKey: string, code: string, checked: boolean): void;
}) {
  const groups = new Map<string, ManifestRoute[]>();
  for (const route of routes) {
    const group = route.group ?? "画面";
    groups.set(group, [...(groups.get(group) ?? []), route]);
  }
  if (routes.length === 0) return <p className="feedback-admin-help">登録済みの画面がありません。先に「アプリ設定」でManifestを登録してください。</p>;
  const active = perspectives.filter((perspective) => perspective.status === "active");
  return <div className="feedback-admin-route-groups">{[...groups].map(([group, items]) => <section key={group}><h3>{group}</h3>{items.map((route) => {
    const scope = selected.find((item) => item.pageKey === route.pageKey);
    const assigned = scope ? effectiveScopePerspectiveCodes(scope, active) : [];
    return <div className={`feedback-admin-route-row${scope ? " is-selected" : ""}`} key={route.pageKey}>
      <label className="feedback-admin-route-choice"><input type="checkbox" checked={Boolean(scope)} onChange={(event) => onToggle(route, event.target.checked)} /><span><strong>{route.label}</strong><code>{route.template}</code></span></label>
      {scope ? <fieldset className="feedback-admin-route-perspectives"><legend>この画面で確認する観点</legend>{active.length > 0 ? active.map((perspective) => {
        const checked = assigned.includes(perspective.code);
        return <label key={perspective.code}><input type="checkbox" checked={checked} disabled={checked && assigned.length === 1} onChange={(event) => onTogglePerspective(route.pageKey, perspective.code, event.target.checked)} />{perspective.label}</label>;
      }) : <p>先に「レビュー観点」で「今回確認」を選んでください。</p>}</fieldset> : null}
    </div>;
  })}</section>)}</div>;
}

function ManifestAdministration({ transport, applicationKey, onError }: {
  transport: FeedbackTransport; applicationKey: string; onError(error: string | null): void;
}) {
  const [manifest, setManifest] = useState<Schemas["FeedbackApplicationManifestV1"] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const load = useCallback(async () => {
    setState("loading");
    try {
      const resource = await transport.request<Schemas["FeedbackApplicationManifestV1"]>(
        `/applications/${encodeURIComponent(applicationKey)}/manifest`
      );
      setManifest(resource.value);
      setState("ready");
      onError(null);
    } catch (caught) {
      if (caught instanceof FeedbackTransportError && caught.status === 404) {
        setManifest(null);
        setState("missing");
        onError(null);
      } else {
        onError(messageOf(caught));
      }
    }
  }, [applicationKey, onError, transport]);
  useEffect(() => { void load(); }, [load]);
  return <div className="feedback-admin-card feedback-admin-card-wide"><div className="feedback-admin-card-heading"><div><h2>アプリ・画面設定</h2><p className="feedback-admin-help">CI/CDで同期した画面定義を表示します。この画面でJSONを編集する必要はありません。</p></div><button type="button" onClick={() => void load()}>再読み込み</button></div>
    {state === "loading" ? <p role="status">画面設定を確認しています…</p> : null}
    {state === "missing" ? <div className="feedback-admin-empty" role="status"><strong>画面設定がまだ同期されていません</strong><p>CI/CDまたはbootstrap jobで<code>feedback manifest apply</code>を実行してください。</p></div> : null}
    {state === "ready" && manifest ? <><dl className="feedback-admin-summary feedback-admin-manifest-summary"><div><dt>アプリ名</dt><dd>{manifest.displayName}</dd></div><div><dt>アプリキー</dt><dd><code>{manifest.applicationKey}</code></dd></div><div><dt>設定バージョン</dt><dd>{manifest.manifestVersion}</dd></div><div><dt>登録画面</dt><dd>{manifest.routes.length}画面</dd></div></dl><ManifestRouteInventory routes={manifest.routes} /></> : null}
  </div>;
}

function ManifestRouteInventory({ routes }: { routes: ManifestRoute[] }) {
  const groups = new Map<string, ManifestRoute[]>();
  for (const route of routes) {
    const group = route.group ?? "その他の画面";
    groups.set(group, [...(groups.get(group) ?? []), route]);
  }
  return <div className="feedback-admin-manifest-routes"><h3>レビュー対象にできる画面</h3>{[...groups].map(([group, items]) => <section key={group}><h4>{group}<span>{items.length}画面</span></h4><ul>{items.map((route) => <li key={route.pageKey}><span><strong>{route.label}</strong><small>{route.pageKey}</small></span><code>{route.template}</code></li>)}</ul></section>)}</div>;
}

function RetentionAndExport({
  transport, scopeQuery, applicationKey, environmentKey, externalWorkspaceKey, locale, timezone, onError
}: {
  transport: FeedbackTransport; scopeQuery: string; applicationKey: string; environmentKey: string;
  externalWorkspaceKey: string; locale: string; timezone: string; onError(error: string | null): void;
}) {
  const [policy, setPolicy] = useState<Schemas["FeedbackRetentionPolicy"] | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [activeExport, setActiveExport] = useState<ActiveExport | null>(null);
  const [creatingExport, setCreatingExport] = useState(false);
  const creatingExportRef = useRef(false);
  const exportGeneration = useRef(0);
  const statusRequestGeneration = useRef(0);
  const automaticallyDownloaded = useRef(new Set<string>());
  const downloadsInFlight = useRef(new Set<string>());
  const [backupPolicy, setBackupPolicy] = useState<BackupPolicy | null>(null);
  const [backupPolicyView, setBackupPolicyView] = useState<BackupPolicyView | null>(null);
  const [backupEtag, setBackupEtag] = useState<string | null>(null);
  const [backups, setBackups] = useState<BackupRun[]>([]);
  const load = useCallback(async () => {
    try {
      const [retention, backup, runs] = await Promise.all([
        transport.request<Schemas["FeedbackRetentionPolicy"]>(`/retention-policy?${scopeQuery}`),
        transport.request<BackupPolicyView>(`/backup-policy?${scopeQuery}`),
        transport.request<Schemas["FeedbackBackupRunPage"]>(`/backups?${scopeQuery}`)
      ]);
      setPolicy(retention.value); setEtag(retention.etag);
      setBackupPolicy(backup.value.policy); setBackupPolicyView(backup.value); setBackupEtag(backup.etag);
      setBackups(runs.value.items);
    } catch (caught) { onError(messageOf(caught)); }
  }, [onError, scopeQuery, transport]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => {
    exportGeneration.current += 1;
    statusRequestGeneration.current += 1;
  }, []);
  const save = async () => {
    if (!policy || !etag) return;
    try {
      await transport.request(`/retention-policy?${scopeQuery}`, { method: "PATCH", ifMatch: etag, body: policy });
      await load();
    } catch (caught) { onError(messageOf(caught)); }
  };
  const createExport = async () => {
    if (creatingExportRef.current || activeExport?.job.status === "queued" || activeExport?.job.status === "running") return;
    const generation = exportGeneration.current + 1;
    exportGeneration.current = generation;
    statusRequestGeneration.current += 1;
    const requestedFormat = format;
    creatingExportRef.current = true;
    setCreatingExport(true);
    setActiveExport(null);
    try {
      const resource = await transport.request<ExportJob>("/exports", {
        method: "POST", idempotencyKey: idempotencyKey(),
        body: { applicationKey, environmentKey, externalWorkspaceKey, format: requestedFormat, locale, timezone }
      });
      if (generation !== exportGeneration.current) return;
      setActiveExport({
        job: resource.value,
        format: requestedFormat,
        pollingError: null,
        pollingFailureCount: 0,
        downloadError: null,
        downloadState: resource.value.status === "completed" ? "downloading" : "idle"
      });
      onError(null);
    } catch (caught) {
      if (generation === exportGeneration.current) onError(messageOf(caught));
    } finally {
      creatingExportRef.current = false;
      if (generation === exportGeneration.current) setCreatingExport(false);
    }
  };
  const saveBackupPolicy = async () => {
    if (!backupPolicy || !backupEtag) return;
    try {
      await transport.request(`/backup-policy?${scopeQuery}`, {
        method: "PATCH", ifMatch: backupEtag, body: backupPolicy
      });
      await load();
    } catch (caught) { onError(messageOf(caught)); }
  };
  const downloadBackup = async (backup: BackupRun) => {
    if (!backup.downloadUrl) return;
    try {
      const binary = await transport.requestBinary(`/backups/${backup.id}/download`);
      const url = URL.createObjectURL(new Blob([binary.bytes.slice().buffer as ArrayBuffer], { type: binary.contentType }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `feedback-backup-${backup.id}.zip`; anchor.click();
      URL.revokeObjectURL(url);
    } catch (caught) { onError(messageOf(caught)); }
  };
  const retryBackup = async (backup: BackupRun) => {
    try {
      await transport.request(`/backups/${backup.id}/retry?${scopeQuery}`, { method: "POST" });
      await load();
    } catch (caught) { onError(messageOf(caught)); }
  };
  const downloadExport = useCallback(async (target: ExportJob, requestedFormat: ExportFormat, generation: number) => {
    if (downloadsInFlight.current.has(target.id)) return;
    downloadsInFlight.current.add(target.id);
    let url: string | null = null;
    try {
      const binary = await transport.requestBinary(`/exports/${target.id}/download`);
      if (generation !== exportGeneration.current) return;
      url = URL.createObjectURL(new Blob([binary.bytes.slice().buffer as ArrayBuffer], { type: binary.contentType }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `feedback-${target.id}.${requestedFormat === "evidence-package" ? "zip" : requestedFormat}`;
      anchor.hidden = true;
      document.body.append(anchor);
      try { anchor.click(); }
      finally { anchor.remove(); }
      setActiveExport((current) => current?.job.id === target.id
        ? { ...current, downloadError: null, downloadState: "succeeded" }
        : current);
    } catch (caught) {
      if (generation !== exportGeneration.current) return;
      setActiveExport((current) => current?.job.id === target.id
        ? { ...current, downloadError: messageOf(caught), downloadState: "failed" }
        : current);
    } finally {
      downloadsInFlight.current.delete(target.id);
      if (url) {
        const urlToRelease = url;
        setTimeout(() => URL.revokeObjectURL(urlToRelease), 0);
      }
    }
  }, [transport]);
  useEffect(() => {
    const current = activeExport;
    if (!current || (current.job.status !== "queued" && current.job.status !== "running")) return;
    const generation = exportGeneration.current;
    const timer = setTimeout(() => {
      if (generation !== exportGeneration.current) return;
      const requestGeneration = statusRequestGeneration.current + 1;
      statusRequestGeneration.current = requestGeneration;
      void transport.request<ExportJob>(`/exports/${current.job.id}`).then(
        (resource) => {
          if (generation !== exportGeneration.current || requestGeneration !== statusRequestGeneration.current) return;
          setActiveExport((latest) => latest?.job.id === current.job.id
            ? withUpdatedExportJob(latest, resource.value)
            : latest);
        },
        (caught) => {
          if (generation !== exportGeneration.current || requestGeneration !== statusRequestGeneration.current) return;
          setActiveExport((latest) => latest?.job.id === current.job.id
            ? { ...latest, pollingError: messageOf(caught), pollingFailureCount: latest.pollingFailureCount + 1 }
            : latest);
        }
      );
    }, exportPollingDelay(current.pollingFailureCount));
    return () => clearTimeout(timer);
  }, [activeExport?.job, activeExport?.pollingFailureCount, transport]);
  useEffect(() => {
    if (!activeExport || activeExport.job.status !== "completed" || activeExport.downloadState !== "downloading" || automaticallyDownloaded.current.has(activeExport.job.id)) return;
    automaticallyDownloaded.current.add(activeExport.job.id);
    void downloadExport(activeExport.job, activeExport.format, exportGeneration.current);
  }, [activeExport, downloadExport]);
  const refreshJob = async () => {
    if (!activeExport) return;
    const target = activeExport.job;
    const generation = exportGeneration.current;
    const requestGeneration = statusRequestGeneration.current + 1;
    statusRequestGeneration.current = requestGeneration;
    try {
      const resource = await transport.request<ExportJob>(`/exports/${target.id}`);
      if (generation !== exportGeneration.current || requestGeneration !== statusRequestGeneration.current) return;
      setActiveExport((current) => current?.job.id === target.id
        ? withUpdatedExportJob(current, resource.value)
        : current);
    } catch (caught) {
      if (generation !== exportGeneration.current || requestGeneration !== statusRequestGeneration.current) return;
      setActiveExport((current) => current?.job.id === target.id
        ? { ...current, pollingError: messageOf(caught), pollingFailureCount: current.pollingFailureCount + 1 }
        : current);
    }
  };
  const download = () => {
    if (!activeExport || activeExport.job.status !== "completed" || activeExport.downloadState === "downloading") return;
    setActiveExport({ ...activeExport, downloadError: null, downloadState: "downloading" });
    void downloadExport(activeExport.job, activeExport.format, exportGeneration.current);
  };
  return <div className="feedback-admin-grid">
    <div className="feedback-admin-card"><h2>保存期間</h2>{policy ? <>
      <label>証跡の保存日数（空欄は無期限）<input type="number" min={1} value={policy.evidenceRetentionDays ?? ""} onChange={(event) => setPolicy({ ...policy, evidenceRetentionDays: event.target.value ? Number(event.target.value) : null })} /></label>
      <label>エクスポートの保存日数<input type="number" min={1} value={policy.exportRetentionDays} onChange={(event) => setPolicy({ ...policy, exportRetentionDays: Number(event.target.value) })} /></label>
      <button type="button" onClick={() => void save()}>保存</button>
    </> : null}</div>
    <div className="feedback-admin-card"><h2>データをエクスポート</h2><p className="feedback-admin-help">レビュー記録をファイルとして出力します。</p>
      <label>ファイル形式<select value={format} disabled={creatingExport || activeExport?.job.status === "queued" || activeExport?.job.status === "running"} onChange={(event) => setFormat(event.target.value as ExportFormat)}><option value="csv">CSV（表計算ソフト向け）</option><option value="xlsx">Excel（XLSX）</option><option value="evidence-package">証跡パッケージ（Power BI向けZIP）</option></select></label>
      <div className="feedback-admin-actions"><button type="button" disabled={creatingExport || activeExport?.job.status === "queued" || activeExport?.job.status === "running"} onClick={() => void createExport()}>{creatingExport ? "作成を依頼中..." : "エクスポートを作成"}</button>
        {activeExport ? <button type="button" disabled={activeExport.downloadState === "downloading"} onClick={() => void refreshJob()}>状態を再確認</button> : null}
        {activeExport?.job.status === "completed" ? <button type="button" disabled={activeExport.downloadState === "downloading"} onClick={download}>{activeExport.downloadState === "downloading" ? "ダウンロード中..." : "ファイルを再ダウンロード"}</button> : null}</div>
      {activeExport ? <div className="feedback-admin-export-status"><p role="status">状態: {exportStatusLabel(activeExport.job.status)}</p>
        {activeExport.job.status === "failed" ? <p className="feedback-admin-error" role="alert">エクスポートに失敗しました: {activeExport.job.error || "原因は通知されませんでした"}</p> : null}
        {activeExport.pollingError ? <p className="feedback-admin-error" role="alert">状態を確認できませんでした: {activeExport.pollingError}</p> : null}
        {activeExport.downloadError ? <p className="feedback-admin-error" role="alert">ファイルをダウンロードできませんでした: {activeExport.downloadError}</p> : null}
      </div> : null}
    </div>
    <div className="feedback-admin-card"><h2>自動証跡バックアップ</h2>{backupPolicy ? <>
      <label><input type="checkbox" checked={backupPolicy.enabled} onChange={(event) => setBackupPolicy({ ...backupPolicy, enabled: event.target.checked })} />有効</label>
      <label>タイムゾーン<input value={backupPolicy.timezone} onChange={(event) => setBackupPolicy({ ...backupPolicy, timezone: event.target.value })} /></label>
      <label>日次フル実行時刻<input type="time" value={backupPolicy.fullBackupAt} onChange={(event) => setBackupPolicy({ ...backupPolicy, fullBackupAt: event.target.value })} /></label>
      <label>差分間隔（分）<input type="number" min={15} max={1440} value={backupPolicy.incrementalIntervalMinutes} onChange={(event) => setBackupPolicy({ ...backupPolicy, incrementalIntervalMinutes: Number(event.target.value) })} /></label>
      <label><input type="checkbox" checked={backupPolicy.includeEvidence} onChange={(event) => setBackupPolicy({ ...backupPolicy, includeEvidence: event.target.checked })} />証跡画像を含める</label>
      <label>保存日数（空欄は無期限）<input type="number" value={backupPolicy.retentionDays ?? ""} onChange={(event) => setBackupPolicy({ ...backupPolicy, retentionDays: event.target.value ? Number(event.target.value) : null })} /></label>
      <dl>
        <dt>次回実行</dt><dd>{backupPolicyView?.nextExecutionAt ? new Date(backupPolicyView.nextExecutionAt).toLocaleString(locale) : "停止中"}</dd>
        <dt>次回フル</dt><dd>{backupPolicyView?.nextFullAt ? new Date(backupPolicyView.nextFullAt).toLocaleString(locale) : "-"}</dd>
        <dt>次回差分</dt><dd>{backupPolicyView?.nextIncrementalAt ? new Date(backupPolicyView.nextIncrementalAt).toLocaleString(locale) : "-"}</dd>
        <dt>最終成功</dt><dd>{backupPolicyView?.lastSuccessfulAt ? new Date(backupPolicyView.lastSuccessfulAt).toLocaleString(locale) : "未実行"}</dd>
        <dt>変更 / 監査カーソル</dt><dd>{backupPolicyView?.changeCursor ?? 0} / {backupPolicyView?.auditCursor ?? 0}</dd>
      </dl>
      <button type="button" onClick={() => void saveBackupPolicy()}>バックアップ方針を保存</button>
    </> : null}</div>
    <div className="feedback-admin-card"><h2>バックアップ履歴</h2>{backups.map((backup) => <article key={backup.id}>
      <strong>{backup.kind}</strong> {backup.status} {new Date(backup.scheduledFor).toLocaleString(locale)}
      {backup.archiveSha256 ? <code>{backup.archiveSha256.slice(0, 16)}…</code> : null}
      <p>変更 {backup.fromChangeSequence} → {backup.toChangeSequence ?? "-"} / 監査 {backup.fromAuditSequence} → {backup.toAuditSequence ?? "-"}</p>
      {backup.error ? <p>{backup.error}</p> : null}
      <div className="feedback-admin-actions">
        {backup.downloadUrl ? <button type="button" onClick={() => void downloadBackup(backup)}>ZIPを取得</button> : null}
        {backup.status === "failed" ? <button type="button" onClick={() => void retryBackup(backup)}>再試行</button> : null}
      </div>
    </article>)}</div>
  </div>;
}

function MembershipAdministration({ transport, scopeQuery, onError }: {
  transport: FeedbackTransport; scopeQuery: string; onError(error: string | null): void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [issuer, setIssuer] = useState(""); const [subject, setSubject] = useState("");
  const [permissions, setPermissions] = useState("feedback.read");
  const load = useCallback(async () => {
    try { setMembers((await transport.request<Member[]>(`/memberships?${scopeQuery}`)).value); }
    catch (caught) { onError(messageOf(caught)); }
  }, [onError, scopeQuery, transport]);
  useEffect(() => { void load(); }, [load]);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await transport.request(`/memberships?${scopeQuery}`, {
        method: "POST", idempotencyKey: idempotencyKey(),
        body: { issuer, subject, permissions: permissionList(permissions) }
      });
      setSubject(""); await load();
    } catch (caught) { onError(messageOf(caught)); }
  };
  const update = async (member: Member, next: string) => {
    try {
      await transport.request(`/memberships/${member.userId}?${scopeQuery}`, {
        method: "PATCH", ifMatch: versionEtag(member.version), body: { permissions: permissionList(next) }
      });
      await load();
    } catch (caught) { onError(messageOf(caught)); }
  };
  const remove = async (member: Member) => {
    try {
      await transport.request(`/memberships/${member.userId}?${scopeQuery}`, {
        method: "DELETE", ifMatch: versionEtag(member.version)
      });
      await load();
    } catch (caught) { onError(messageOf(caught)); }
  };
  return <div className="feedback-admin-grid"><form className="feedback-admin-card" onSubmit={(event) => void create(event)}>
    <h2>メンバーを追加</h2><p className="feedback-admin-help">ログインに使う発行者とユーザーIDを入力してください。</p><label>発行者（Issuer）<input required value={issuer} onChange={(event) => setIssuer(event.target.value)} /></label>
    <label>ユーザーID（Subject）<input required value={subject} onChange={(event) => setSubject(event.target.value)} /></label>
    <label>権限（カンマ区切り）<input value={permissions} onChange={(event) => setPermissions(event.target.value)} /><small>例: feedback.read, feedback.comment</small></label><button>追加</button>
  </form><div className="feedback-admin-card"><h2>メンバー一覧</h2>{members.map((member) => <MemberRow key={member.userId} member={member} onSave={update} onDelete={remove} />)}</div></div>;
}

function MemberRow({ member, onSave, onDelete }: { member: Member; onSave(member: Member, value: string): void; onDelete(member: Member): void }) {
  const [value, setValue] = useState(member.permissions.join(","));
  return <article><strong>{member.displayName ?? member.subject}</strong><input aria-label={`${member.subject} permissions`} value={value} onChange={(event) => setValue(event.target.value)} />
    <div className="feedback-admin-actions"><button type="button" onClick={() => onSave(member, value)}>保存</button><button type="button" onClick={() => onDelete(member)}>削除</button></div></article>;
}

function NotificationAdministration({ transport, scopeQuery, onError }: {
  transport: FeedbackTransport; scopeQuery: string; onError(error: string | null): void;
}) {
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [connectorTypes, setConnectorTypes] = useState<ConnectorType[]>([]);
  const [connectors, setConnectors] = useState<NotificationConnector[]>([]);
  const [connectorType, setConnectorType] = useState("");
  const [connectorName, setConnectorName] = useState("");
  const [destinationRef, setDestinationRef] = useState("");
  const load = useCallback(async () => {
    try {
      const [deliveryResource, typeResource, connectorResource] = await Promise.all([
        transport.request<Delivery[]>(`/notification-deliveries?${scopeQuery}`),
        transport.request<ConnectorType[]>(`/connector-types?${scopeQuery}`),
        transport.request<NotificationConnector[]>(`/notification-connectors?${scopeQuery}`)
      ]);
      setDeliveries(deliveryResource.value);
      setConnectorTypes(typeResource.value); setConnectors(connectorResource.value);
      setConnectorType((current) => current || typeResource.value.find((type) => type.enabled)?.key || "");
    } catch (caught) { onError(messageOf(caught)); }
  }, [onError, scopeQuery, transport]);
  useEffect(() => { void load(); }, [load]);
  const retry = async (id: string) => {
    try { await transport.request(`/notification-deliveries/${id}/retry?${scopeQuery}`, { method: "POST" }); await load(); }
    catch (caught) { onError(messageOf(caught)); }
  };
  const createConnector = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await transport.request(`/notification-connectors?${scopeQuery}`, {
        method: "POST",
        body: { connectorType, name: connectorName, destinationRef, enabled: true, includeBody: false }
      });
      setConnectorName(""); setDestinationRef(""); await load();
    } catch (caught) { onError(messageOf(caught)); }
  };
  const toggleConnector = async (connector: NotificationConnector) => {
    try {
      await transport.request(`/notification-connectors/${connector.id}?${scopeQuery}`, {
        method: "PATCH", ifMatch: versionEtag(connector.version),
        body: { name: connector.name, destinationRef: connector.destinationRef, enabled: !connector.enabled, includeBody: connector.includeBody }
      });
      await load();
    } catch (caught) { onError(messageOf(caught)); }
  };
  const removeConnector = async (connector: NotificationConnector) => {
    try {
      await transport.request(`/notification-connectors/${connector.id}?${scopeQuery}`, {
        method: "DELETE", ifMatch: versionEtag(connector.version)
      });
      await load();
    } catch (caught) { onError(messageOf(caught)); }
  };
  return <div className="feedback-admin-grid"><form className="feedback-admin-card" onSubmit={(event) => void createConnector(event)}><h2>通知先を追加</h2><p className="feedback-admin-help">管理者が登録済みの接続先を選び、レビュー通知の配送先として追加します。</p>
      <label>種別<select required value={connectorType} onChange={(event) => setConnectorType(event.target.value)}>
        <option value="">選択</option>{connectorTypes.filter((type) => type.enabled).map((type) => <option key={type.key} value={type.key}>{type.displayName}</option>)}
      </select></label>
      <label>表示名<input required value={connectorName} onChange={(event) => setConnectorName(event.target.value)} /></label>
      <label>接続先の参照名<input required value={destinationRef} onChange={(event) => setDestinationRef(event.target.value)} /><small>サーバー側で登録した接続先の名前です。</small></label>
      <button type="submit">追加</button>
    </form>
    <div className="feedback-admin-card"><h2>登録済みの通知先</h2>{connectors.map((connector) => <article key={connector.id}>
      <strong>{connector.name}</strong> {connector.displayName} / {connector.destinationRef} / {connector.enabled ? "有効" : "無効"}
      <p>接続状態: {connector.healthStatus}{connector.healthCheckedAt ? ` (${new Date(connector.healthCheckedAt).toLocaleString()})` : ""}</p>
      {connector.healthError ? <p>{connector.healthError}</p> : null}
      <div className="feedback-admin-actions"><button type="button" onClick={() => void toggleConnector(connector)}>{connector.enabled ? "無効化" : "有効化"}</button><button type="button" onClick={() => void removeConnector(connector)}>削除</button></div>
    </article>)}</div>
    <div className="feedback-admin-card"><h2>通知の配送履歴</h2>{deliveries.map((delivery) => <article key={delivery.id}><strong>{delivery.eventType}</strong> {delivery.status === "failed" ? "失敗" : delivery.status === "delivered" ? "成功" : delivery.status === "processing" ? "処理中" : "待機中"} ({delivery.attemptCount}回)
      {delivery.connectorName ? <span> / {delivery.connectorName}</span> : null}
      {delivery.lastError ? <p>{delivery.lastError}</p> : null}{delivery.status === "failed" ? <button type="button" onClick={() => void retry(delivery.id)}>再送</button> : null}</article>)}</div></div>;
}

export class FeedbackAdminErrorBoundary extends Component<{
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
}, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { this.props.onError?.(error, info); }
  render() { return this.state.failed ? (this.props.fallback ?? null) : this.props.children; }
}

function query(values: Record<string, string>): string {
  return Object.entries(values).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
}
function parseScopeDraft(value: string): SessionScope[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is Record<string, unknown> & { pageKey: string } =>
      item != null && typeof item === "object" && typeof item.pageKey === "string"
    ).map((item) => ({
      pageKey: item.pageKey,
      routeTemplate: typeof item.routeTemplate === "string" ? item.routeTemplate : null,
      reviewable: item.reviewable !== false,
      perspectiveCodes: Array.isArray(item.perspectiveCodes)
        ? item.perspectiveCodes.filter((code): code is string => typeof code === "string")
        : []
    }));
  } catch {
    return [];
  }
}
function parsePerspectiveDraft(value: string): SessionPerspective[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is SessionPerspective =>
      item != null && typeof item === "object" && typeof item.code === "string" && typeof item.label === "string" && typeof item.status === "string"
    );
  } catch {
    return [];
  }
}
function activePerspectiveCodes(perspectives: readonly SessionPerspective[]): string[] {
  return perspectives.filter((item) => item.status === "active").map((item) => item.code);
}
function effectiveScopePerspectiveCodes(
  scope: Pick<SessionScope, "perspectiveCodes">,
  perspectives: readonly SessionPerspective[]
): string[] {
  return scope.perspectiveCodes?.length ? [...scope.perspectiveCodes] : activePerspectiveCodes(perspectives);
}
function normalizeScopePerspectives(
  scopes: readonly SessionScope[],
  perspectives: readonly SessionPerspective[]
): SessionScope[] {
  return scopes.map((scope) => ({
    ...scope,
    perspectiveCodes: effectiveScopePerspectiveCodes(scope, perspectives)
  }));
}
function reconcileScopePerspectiveCodes(
  scopes: readonly SessionScope[],
  perspectives: readonly SessionPerspective[]
): SessionScope[] {
  const active = activePerspectiveCodes(perspectives);
  const activeSet = new Set(active);
  return scopes.map((scope) => {
    if (!scope.perspectiveCodes?.length) return scope;
    const retained = scope.perspectiveCodes.filter((code) => activeSet.has(code));
    return { ...scope, perspectiveCodes: retained.length > 0 ? retained : [...active] };
  });
}
function withToggledPerspective(
  scope: SessionScope,
  perspectives: readonly SessionPerspective[],
  code: string,
  checked: boolean
): SessionScope {
  const assigned = effectiveScopePerspectiveCodes(scope, perspectives);
  const next = checked
    ? [...new Set([...assigned, code])]
    : assigned.filter((item) => item !== code);
  return next.length > 0 ? { ...scope, perspectiveCodes: next } : scope;
}
function perspectiveDisplayLabel(code: string, perspectives?: readonly SessionPerspective[]): string {
  return perspectives?.find((item) => item.code === code)?.label
    ?? perspectiveDefinitions.find(([definitionCode]) => definitionCode === code)?.[1]
    ?? "その他の観点";
}
function permissionList(value: string): string[] { return value.split(",").map((item) => item.trim()).filter(Boolean); }
function sessionStatusLabel(value: Session["status"]): string {
  return value === "open" ? "受付中" : value === "closed" ? "終了" : "下書き";
}
function exportStatusLabel(value: ExportJob["status"]): string {
  return value === "queued" ? "待機中"
    : value === "running" ? "作成中"
      : value === "completed" ? "完了"
        : "失敗";
}
function withUpdatedExportJob(current: ActiveExport, job: ExportJob): ActiveExport {
  const enteredCompleted = job.status === "completed" && current.job.status !== "completed";
  return {
    ...current,
    job,
    pollingError: null,
    pollingFailureCount: 0,
    downloadError: job.status === "completed" && !enteredCompleted ? current.downloadError : null,
    downloadState: job.status === "completed"
      ? enteredCompleted ? "downloading" : current.downloadState
      : "idle"
  };
}
function exportPollingDelay(failureCount: number): number {
  return Math.min(1000 * (2 ** Math.min(failureCount, 4)), 10_000);
}
function dateTimeLocal(value?: string | null): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
function dateTimeToISO(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
function idempotencyKey(): string { return `feedback-admin-${crypto.randomUUID()}`; }

function directThreadLink(rawUrl: string, threadId: string): string {
  const url = new URL(rawUrl, window.location.origin);
  url.searchParams.set("feedbackThread", threadId);
  return url.toString();
}

function openPendingWindow(): Window | null {
  try {
    const pending = window.open("", "_blank");
    if (pending) {
      pending.opener = null;
      pending.document.title = "対象アプリを開いています…";
      pending.document.body.textContent = "対象のフィードバックスレッドを開いています…";
    }
    return pending;
  } catch {
    return null;
  }
}
function versionEtag(version: number): string { return `"v${version}"`; }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export type { FeedbackTransport } from "@feedback/core";
