import { useEffect, useRef, useState } from "react";
import type { RedmineAttachmentContent, RedmineThreadV1 } from "@feedback/redmine-core";
import { useDismissiblePanel } from "./dismissible.js";
import { feedbackErrorMessage } from "./error-message.js";

export type ThreadDrawerProps = {
  thread: RedmineThreadV1 | null;
  loading: boolean;
  error: string | null;
  followed: boolean;
  onClose(): void;
  onFollowChange(followed: boolean): void;
  canReply: boolean;
  canEditOwn: boolean;
  participantName: string;
  side: "left" | "right";
  onReply(body: string): Promise<void>;
  onEdit(messageId: string, body: string, expectedVersion: number): Promise<void>;
  onAttachment(attachmentId: number): Promise<RedmineAttachmentContent>;
};

type Preview = { attachmentId: number; url: string; contentType: string; filename: string };

export function ThreadDrawer(props: ThreadDrawerProps) {
  const panelRef = useDismissiblePanel<HTMLElement>(props.onClose);
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [editing, setEditing] = useState<{ messageId: string; body: string; version: number } | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const objectUrls = useRef(new Set<string>());
  const revokeTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => {
    revokeTimers.current.forEach((timer) => clearTimeout(timer));
    revokeTimers.current.clear();
    objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.current.clear();
  }, []);
  useEffect(() => {
    revokeTimers.current.forEach((timer) => clearTimeout(timer));
    revokeTimers.current.clear();
    objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.current.clear();
    setPreviews([]);
    setAttachmentError(null);
  }, [props.thread?.threadId]);
  const download = async (attachmentId: number) => {
    try {
      const content = await props.onAttachment(attachmentId);
      const blob = new Blob([Uint8Array.from(content.bytes).buffer], { type: content.contentType });
      const url = URL.createObjectURL(blob);
      objectUrls.current.add(url);
      setPreviews((current) => [...current.filter((preview) => preview.attachmentId !== attachmentId), {
        attachmentId,
        url,
        contentType: content.contentType,
        filename: content.filename
      }]);
      setAttachmentError(null);
      const timer = setTimeout(() => {
        URL.revokeObjectURL(url);
        objectUrls.current.delete(url);
        revokeTimers.current.delete(timer);
        setPreviews((current) => current.filter((preview) => preview.url !== url));
      }, 300_000);
      revokeTimers.current.add(timer);
    } catch (error) {
      setAttachmentError(feedbackErrorMessage(error, "添付ファイル"));
    }
  };
  const submitReply = async () => {
    if (!reply.trim() || mutating) return;
    setMutating(true);
    try {
      await props.onReply(reply.trim());
      setReply("");
      setMutationError(null);
    } catch (error) {
      setMutationError(feedbackErrorMessage(error, "返信"));
    } finally {
      setMutating(false);
    }
  };
  const submitEdit = async () => {
    if (!editing?.body.trim() || mutating) return;
    setMutating(true);
    try {
      await props.onEdit(editing.messageId, editing.body.trim(), editing.version);
      setEditing(null);
      setMutationError(null);
    } catch (error) {
      setMutationError(feedbackErrorMessage(error, "編集"));
    } finally {
      setMutating(false);
    }
  };
  const messages = props.thread ? conversationMessages(props.thread) : [];
  return <aside
    ref={panelRef}
    role="dialog"
    className={`feedback-redmine-panel feedback-redmine-drawer is-${props.side}`}
    aria-label="フィードバックスレッド"
  >
    <header className="feedback-redmine-panel-header">
      <h2>{props.thread ? `#${props.thread.issueId} Feedback` : "Feedback"}</h2>
      <button type="button" className="feedback-redmine-icon-button" onClick={props.onClose} aria-label="スレッドを閉じる">×</button>
    </header>
    {props.loading && !props.thread && <p role="status">Redmineから詳細を取得しています…</p>}
    {props.error && <p role="alert">{props.error}</p>}
    {props.thread && <>
      <dl className="feedback-redmine-thread-meta">
        <div><dt>状態</dt><dd>{props.thread.status.name}</dd></div>
        <div><dt>担当者</dt><dd>{props.thread.assignee?.name ?? "未担当"}</dd></div>
        <div><dt>優先度</dt><dd>{props.thread.priority?.name ?? "なし"}</dd></div>
        <div><dt>トラッカー</dt><dd>{props.thread.tracker.name}</dd></div>
      </dl>
      <label className="feedback-redmine-follow">
        <input
          type="checkbox"
          checked={props.followed}
          onChange={(event) => props.onFollowChange(event.target.checked)}
        />
        このthreadを端末内の通知対象にする
      </label>
      {mutationError && <p role="alert">{mutationError}</p>}
      <ol className="feedback-redmine-messages" aria-live="polite">
        {messages.map((message) => <li key={message.id}>
          <article>
            <strong>{message.author.displayName}</strong><time>{new Date(message.createdAt).toLocaleString("ja-JP")}</time>
            <small>{message.kind === "initial" ? "最初のコメント" : message.author.kind === "redmine" ? "開発者からの返信" : "返信"}</small>
            {editing?.messageId === message.id ? <div className="feedback-redmine-edit">
              <textarea maxLength={20_000} value={editing.body} onChange={(event) => setEditing({ ...editing, body: event.target.value })} />
              <button type="button" disabled={mutating || !editing.body.trim()} onClick={() => void submitEdit()}>保存</button>
              <button type="button" disabled={mutating} onClick={() => setEditing(null)}>キャンセル</button>
            </div> : <>
              <p className="feedback-redmine-body">{message.body}</p>
              {message.editedAt && <small>編集済み {new Date(message.editedAt).toLocaleString("ja-JP")}</small>}
              {props.canEditOwn && message.canEdit && <button type="button" onClick={() => setEditing({ messageId: message.id, body: message.body, version: message.version })}>編集</button>}
            </>}
            {message.versions.length > 1 && <details>
              <summary>編集履歴（{message.versions.length}版）</summary>
              <ol>{message.versions.map((version) => <li key={version.version}>
                <strong>v{version.version}</strong> <time>{new Date(version.editedAt).toLocaleString("ja-JP")}</time>
                <p className="feedback-redmine-body">{version.body}</p>
              </li>)}</ol>
            </details>}
          </article>
        </li>)}
      </ol>
      <ol className="feedback-redmine-timeline feedback-redmine-activities" aria-label="Redmine更新履歴">
        {props.thread.timeline.map((item, index) => <li key={`${item.kind}-${item.journalId ?? "invalid"}-${index}`}>
          {item.kind === "activity" && <p>{item.author.name}: {item.field}を変更（{item.oldValue ?? "なし"} → {item.newValue ?? "なし"}）</p>}
          {item.kind === "diagnostic" && <p role="note">{item.message}</p>}
        </li>)}
      </ol>
      {props.canReply && !props.thread.closed ? <section className="feedback-redmine-reply" aria-label="返信">
        <label>返信
          <textarea maxLength={20_000} value={reply} onChange={(event) => setReply(event.target.value)} />
        </label>
        <button type="button" disabled={mutating || !reply.trim()} onClick={() => void submitReply()}>{mutating ? "送信中…" : "返信する"}</button>
      </section> : props.thread.closed ? <p className="feedback-redmine-readonly">このthreadは終了済みのため返信できません。自分の既存投稿は編集できます。</p> : null}
      <section aria-label="添付ファイル">
        <h3>添付ファイル</h3>
        {attachmentError && <p role="alert">{attachmentError}</p>}
        <ul>{props.thread.attachments.map((attachment) => {
          const preview = previews.find((value) => value.attachmentId === attachment.id);
          return <li key={attachment.id}>
            <span>{attachment.filename} ({attachment.byteSize} bytes)</span>
            <button
              type="button"
              className={attachment.primaryEvidence && attachment.inlinePreview ? "feedback-redmine-button-primary" : "feedback-redmine-button-secondary"}
              onClick={() => void download(attachment.id)}
            >{attachment.primaryEvidence && attachment.inlinePreview ? "証跡" : "安全に取得"}</button>
            {preview && attachment.inlinePreview && (preview.contentType === "image/png" || preview.contentType === "image/webp") &&
              <img src={preview.url} alt={attachment.primaryEvidence ? "証跡画像" : preview.filename} />}
            {preview && (!attachment.inlinePreview || (preview.contentType !== "image/png" && preview.contentType !== "image/webp")) &&
              <a href={preview.url} download={preview.filename}>ダウンロード</a>}
          </li>;
        })}</ul>
      </section>
      {props.thread.redmineUrl && <a href={props.thread.redmineUrl} target="_blank" rel="noopener noreferrer">Redmineで開く</a>}
      <p className="feedback-redmine-readonly">状態、担当者、優先度の変更は開発者がRedmineで行い、この画面へ自動反映されます。</p>
    </>}
  </aside>;
}

type ConversationMessage = NonNullable<RedmineThreadV1["messages"]>[number];

function conversationMessages(thread: RedmineThreadV1): ConversationMessage[] {
  if (thread.messages) return thread.messages;
  return [{
    id: thread.threadId,
    kind: "initial",
    journalId: null,
    body: thread.initialComment,
    author: { kind: "redmine", participantId: null, displayName: thread.author.name },
    createdAt: thread.createdAt,
    editedAt: null,
    version: 1,
    versions: [{ version: 1, body: thread.initialComment, editedAt: thread.createdAt }],
    canEdit: false
  }, ...thread.timeline.flatMap((item) => item.kind === "reply" ? [{
    id: item.messageId ?? `00000000-0000-4000-8000-${item.journalId.toString(16).padStart(12, "0").slice(-12)}`,
    kind: "reply" as const,
    journalId: item.journalId,
    body: item.body,
    author: {
      kind: item.participantId ? "participant" as const : "redmine" as const,
      participantId: item.participantId ?? null,
      displayName: item.displayName ?? item.author.name
    },
    createdAt: item.createdAt,
    editedAt: item.updatedAt,
    version: item.version ?? 1,
    versions: item.versions ?? [{ version: 1, body: item.body, editedAt: item.createdAt }],
    canEdit: item.canEdit ?? false
  }] : [])];
}
