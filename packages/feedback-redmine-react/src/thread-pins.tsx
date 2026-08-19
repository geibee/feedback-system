import type { CSSProperties } from "react";
import type { RedmineThreadSummaryV1 } from "@feedback/redmine-core";

export function ThreadPins(props: {
  threads: RedmineThreadSummaryV1[];
  onOpen(threadId: string): void;
}) {
  return <div aria-label="Feedback pin">
    {props.threads.flatMap((thread) => {
      const style = pinStyle(thread);
      return style ? [<button
        key={thread.threadId}
        type="button"
        className="feedback-redmine-pin"
        style={style}
        aria-label={`Feedback pin: ${thread.initialComment || thread.subject}`}
        onClick={() => props.onOpen(thread.threadId)}
      >●</button>] : [];
    })}
  </div>;
}

function pinStyle(thread: RedmineThreadSummaryV1): CSSProperties | null {
  const target = thread.locator?.target as Record<string, unknown> | null | undefined;
  if (!target) return null;
  if (
    target.kind === "screen-position" &&
    typeof target.relativeX === "number" &&
    typeof target.relativeY === "number"
  ) {
    return { left: `${target.relativeX * 100}vw`, top: `${target.relativeY * 100}vh` };
  }
  if (
    target.kind === "ui-element" &&
    typeof target.elementKey === "string" &&
    typeof target.relativeX === "number" &&
    typeof target.relativeY === "number"
  ) {
    const escape = (globalThis.CSS as { escape?: (value: string) => string } | undefined)?.escape;
    const escaped = escape ? escape(target.elementKey) : target.elementKey.replace(/["\\]/gu, "\\$&");
    const element = document.querySelector<HTMLElement>(`[data-feedback-element-key="${escaped}"]`);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { left: rect.left + rect.width * target.relativeX, top: rect.top + rect.height * target.relativeY };
  }
  return null;
}
