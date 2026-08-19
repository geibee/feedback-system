import type {
  RedmineClientProfileV1,
  RedmineThreadFilter,
  RedmineThreadSort,
  RedmineThreadSummaryV1
} from "@feedback/redmine-core";

export type ThreadListProps = {
  profile: RedmineClientProfileV1;
  threads: RedmineThreadSummaryV1[];
  sort: RedmineThreadSort;
  filter: RedmineThreadFilter;
  loading: boolean;
  nextCursor: string | null;
  onSortChange(sort: RedmineThreadSort): void;
  onFilterChange(filter: RedmineThreadFilter): void;
  onOpen(threadId: string): void;
  onLoadMore(): void;
};

export function ThreadList(props: ThreadListProps) {
  return <section aria-label="Feedback thread一覧" className="feedback-redmine-list">
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
    {props.loading && <p role="status">Redmineから取得しています…</p>}
    {!props.loading && props.threads.length === 0 && <p>この画面のFeedbackはありません。</p>}
    <ol className="feedback-redmine-threads">
      {props.threads.map((thread) => <li key={thread.threadId}>
        <button type="button" onClick={() => props.onOpen(thread.threadId)}>
          <span className="feedback-redmine-status">{thread.status.name}</span>
          <strong>{thread.initialComment || thread.subject}</strong>
          {thread.latestReply && <span className="feedback-redmine-latest">最新の返信: {thread.latestReply}</span>}
          <small>
            {thread.priority?.name ?? "優先度なし"} / {thread.assignee?.name ?? "未担当"} / {thread.updatedAt}
          </small>
        </button>
      </li>)}
    </ol>
    {props.nextCursor && <button type="button" disabled={props.loading} onClick={props.onLoadMore}>さらに読み込む</button>}
  </section>;
}
