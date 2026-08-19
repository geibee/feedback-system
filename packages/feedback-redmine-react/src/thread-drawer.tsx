import { useEffect, useRef, useState } from "react";
import type { RedmineAttachmentContent, RedmineThreadV1 } from "@feedback/redmine-core";
import { feedbackErrorMessage } from "./error-message.js";

export type ThreadDrawerProps = {
  thread: RedmineThreadV1 | null;
  loading: boolean;
  error: string | null;
  followed: boolean;
  onClose(): void;
  onFollowChange(followed: boolean): void;
  onAttachment(attachmentId: number): Promise<RedmineAttachmentContent>;
};

type Preview = { attachmentId: number; url: string; contentType: string; filename: string };

export function ThreadDrawer(props: ThreadDrawerProps) {
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const objectUrls = useRef(new Set<string>());
  const revokeTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => {
    revokeTimers.current.forEach((timer) => clearTimeout(timer));
    revokeTimers.current.clear();
    objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.current.clear();
  }, []);
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
  return <aside className="feedback-redmine-drawer" aria-label="Feedback thread詳細">
    <header>
      <h2>Feedback</h2>
      <button type="button" onClick={props.onClose} aria-label="閉じる">×</button>
    </header>
    {props.loading && !props.thread && <p role="status">Redmineから詳細を取得しています…</p>}
    {props.error && <p role="alert">{props.error}</p>}
    {props.thread && <>
      <dl>
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
      <article>
        <h3>最初のコメント</h3>
        <p className="feedback-redmine-body">{props.thread.initialComment}</p>
      </article>
      <ol className="feedback-redmine-timeline" aria-live="polite">
        {props.thread.timeline.map((item, index) => <li key={`${item.kind}-${item.journalId ?? "invalid"}-${index}`}>
          {item.kind === "reply" && <article>
            <strong>{item.author.name}</strong><time>{item.createdAt}</time>
            <p className="feedback-redmine-body">{item.body}</p>
          </article>}
          {item.kind === "activity" && <p>{item.author.name}: {item.field}を変更（{item.oldValue ?? "なし"} → {item.newValue ?? "なし"}）</p>}
          {item.kind === "diagnostic" && <p role="note">{item.message}</p>}
        </li>)}
      </ol>
      <section aria-label="添付ファイル">
        <h3>添付ファイル</h3>
        {attachmentError && <p role="alert">{attachmentError}</p>}
        <ul>{props.thread.attachments.map((attachment) => {
          const preview = previews.find((value) => value.attachmentId === attachment.id);
          return <li key={attachment.id}>
            <span>{attachment.filename} ({attachment.byteSize} bytes)</span>
            <button type="button" onClick={() => void download(attachment.id)}>安全に取得</button>
            {preview && attachment.inlinePreview && (preview.contentType === "image/png" || preview.contentType === "image/webp") &&
              <img src={preview.url} alt={preview.filename} />}
            {preview && (!attachment.inlinePreview || (preview.contentType !== "image/png" && preview.contentType !== "image/webp")) &&
              <a href={preview.url} download={preview.filename}>ダウンロード</a>}
          </li>;
        })}</ul>
      </section>
      {props.thread.redmineUrl && <a href={props.thread.redmineUrl} target="_blank" rel="noopener noreferrer">Redmineで開く</a>}
      <p className="feedback-redmine-readonly">返信、編集、状態変更はRedmineで行います。</p>
    </>}
  </aside>;
}
