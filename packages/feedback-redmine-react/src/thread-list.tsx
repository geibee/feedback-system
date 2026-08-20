import { useMemo } from "react";
import type {
  RedmineClientProfileV1,
  RedmineThreadFilter,
  RedmineThreadSort,
  RedmineThreadSummaryV1
} from "@geibee/redmine-core";
import { useDismissiblePanel } from "./dismissible.js";

export type ThreadListProps = {
  profile: RedmineClientProfileV1;
  threads: RedmineThreadSummaryV1[];
  totalCount: number;
  sort: RedmineThreadSort;
  filter: RedmineThreadFilter;
  loading: boolean;
  nextCursor: string | null;
  error: string | null;
  onClose(): void;
  onSortChange(sort: RedmineThreadSort): void;
  onFilterChange(filter: RedmineThreadFilter): void;
  onOpen(thread: RedmineThreadSummaryV1): void;
  onLoadMore(): void;
};

export function ThreadList(props: ThreadListProps) {
  const panelRef = useDismissiblePanel<HTMLElement>(props.onClose);
  const groups = useMemo(() => groupThreads(props.threads), [props.threads]);
  return <aside
    ref={panelRef}
    role="dialog"
    aria-label="他の人の投稿を見る"
    className="feedback-redmine-panel feedback-redmine-thread-list"
  >
    <PanelHeader title="他の人の投稿を見る" onClose={props.onClose} />
    <p className="feedback-redmine-note">投稿を選ぶと対象画面へ移動し、そのフィードバックを開きます。</p>
    <div className="feedback-redmine-toolbar">
      <label>並び順
        <select value={props.sort} onChange={(event) => props.onSortChange(event.target.value as RedmineThreadSort)}>
          <option value="created_desc">作成日時（新しい順）</option>
          <option value="created_asc">作成日時（古い順）</option>
          <option value="updated_desc">更新日時（新しい順）</option>
        </select>
      </label>
      <label>状態
        <select
          value={typeof props.filter.status === "string" ? props.filter.status : ""}
          onChange={(event) => props.onFilterChange({
            ...props.filter,
            status: event.target.value ? event.target.value as "open" | "closed" : undefined
          })}
        >
          <option value="">すべて</option>
          <option value="open">未完了</option>
          <option value="closed">完了</option>
        </select>
      </label>
      <label>観点
        <select
          value={props.filter.perspectiveCode ?? ""}
          onChange={(event) => props.onFilterChange({ ...props.filter, perspectiveCode: event.target.value || undefined })}
        >
          <option value="">すべて</option>
          {props.profile.perspectives.map((perspective) =>
            <option key={perspective.code} value={perspective.code}>{perspective.label}</option>)}
        </select>
      </label>
      <label>本文検索
        <input
          type="search"
          value={props.filter.q ?? ""}
          onChange={(event) => props.onFilterChange({ ...props.filter, q: event.target.value || undefined })}
        />
      </label>
    </div>
    {props.error && <p className="feedback-redmine-error" role="alert">{props.error}</p>}
    {props.loading && groups.length === 0 && <p role="status">Redmineから取得しています…</p>}
    {!props.loading && groups.length === 0 && <p className="feedback-redmine-note">投稿はありません。</p>}
    <div className="feedback-redmine-thread-groups">
      {groups.map((group) => <section className="feedback-redmine-thread-group" key={group.key}>
        <header><h3>{group.label}</h3><span>{group.threads.length}件</span></header>
        <ol>{group.threads.map((thread) => <li key={thread.threadId}>
          <button
            type="button"
            disabled={!thread.locator}
            title={thread.locator ? undefined : "場所情報なし"}
            onClick={() => props.onOpen(thread)}
          >
            <span>
              <strong>#{thread.issueId} {perspectiveLabel(props.profile, thread)}</strong>
              <small>{thread.closed ? "完了" : thread.status.name}</small>
            </span>
            <p>{thread.latestReply || thread.initialComment || thread.subject}</p>
            {!thread.locator && <small>場所情報なし</small>}
          </button>
        </li>)}</ol>
      </section>)}
    </div>
    <footer className="feedback-redmine-list-footer">
      <span>{props.totalCount}件</span>
      {props.nextCursor && <button
        className="feedback-redmine-button-secondary"
        type="button"
        disabled={props.loading}
        onClick={props.onLoadMore}
      >さらに読み込む</button>}
    </footer>
  </aside>;
}

function PanelHeader(props: { title: string; onClose(): void }) {
  return <header className="feedback-redmine-panel-header">
    <h2>{props.title}</h2>
    <button type="button" className="feedback-redmine-icon-button" onClick={props.onClose} aria-label="一覧を閉じる">×</button>
  </header>;
}

function groupThreads(threads: RedmineThreadSummaryV1[]) {
  const groups = new Map<string, { key: string; label: string; threads: RedmineThreadSummaryV1[] }>();
  for (const thread of threads) {
    const location = thread.locator?.location;
    const key = location ? `${location.pageKey}:${location.routeTemplate}` : "missing-location";
    const group = groups.get(key) ?? {
      key,
      label: location?.pageKey ?? "場所情報なし",
      threads: []
    };
    group.threads.push(thread);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function perspectiveLabel(profile: RedmineClientProfileV1, thread: RedmineThreadSummaryV1): string {
  return profile.perspectives.find((item) => item.code === thread.perspectiveCode)?.label ?? thread.perspectiveCode ?? "Feedback";
}
