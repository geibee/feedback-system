import { useEffect, useMemo, useState } from "react";
import type { RedmineThreadSummaryV1 } from "@geibee/redmine-core";
import type { FeedbackPinPositionProvider } from "@geibee/core";

export function ThreadPins(props: {
  threads: RedmineThreadSummaryV1[];
  positionProvider?: FeedbackPinPositionProvider;
  activeThreadId: string | null;
  onActiveSideChange(side: "left" | "right"): void;
  onOpen(threadId: string, position: { x: number; y: number }): void;
}) {
  const [positionVersion, setPositionVersion] = useState(0);
  useEffect(() => {
    const update = () => setPositionVersion((value) => value + 1);
    const unsubscribe = props.positionProvider?.subscribe(update);
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(update);
    if (document.body) observer?.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      unsubscribe?.();
      observer?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [props.positionProvider]);
  const pins = useMemo(() => props.threads.flatMap((thread) => {
    const position = thread.locator?.target
      ? resolveFeedbackPinPosition(thread.locator.target, props.positionProvider)
      : null;
    return position ? [{ thread, position }] : [];
    // positionVersionはhost layout変更後のDOM座標再読込を行う。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [positionVersion, props.positionProvider, props.threads]);
  useEffect(() => {
    const active = pins.find(({ thread }) => thread.threadId === props.activeThreadId);
    if (active) props.onActiveSideChange(
      active.position.x > document.documentElement.clientWidth / 2 ? "left" : "right"
    );
  }, [pins, props.activeThreadId, props.onActiveSideChange]);
  return <svg className="feedback-redmine-screen-pins" aria-label="フィードバックのピン">
    {pins.map(({ thread, position }) => <foreignObject
        x={position.x - 4}
        y={position.y - 24}
        width="34"
        height="34"
        className="feedback-redmine-pin-host"
        key={thread.threadId}
      >
        <button
          type="button"
          className={`feedback-redmine-pin${thread.closed ? " is-resolved" : ""}${thread.threadId === props.activeThreadId ? " is-active" : ""}`}
          aria-label={`#${thread.issueId}`}
          aria-pressed={thread.threadId === props.activeThreadId}
          title={thread.initialComment || thread.subject}
          onClick={() => props.onOpen(thread.threadId, position)}
        ><span>{thread.issueId}</span></button>
      </foreignObject>)}
  </svg>;
}

export function resolveFeedbackPinPosition(
  value: Parameters<FeedbackPinPositionProvider["getPosition"]>[0],
  provider?: FeedbackPinPositionProvider
): { x: number; y: number } | null {
  const target = value as Record<string, unknown>;
  const provided = provider?.getPosition(value);
  if (provided) return provided;
  if (
    target.kind === "screen-position" &&
    typeof target.relativeX === "number" &&
    typeof target.relativeY === "number"
  ) {
    return {
      x: target.relativeX * document.documentElement.clientWidth,
      y: target.relativeY * document.documentElement.clientHeight
    };
  }
  if (
    target.kind === "ui-element" &&
    typeof target.elementKey === "string" &&
    typeof target.relativeX === "number" &&
    typeof target.relativeY === "number"
  ) {
    const escape = (globalThis.CSS as { escape?: (value: string) => string } | undefined)?.escape;
    const escaped = escape ? escape(target.elementKey) : target.elementKey.replace(/["\\]/gu, "\\$&");
    const element = document.querySelector<HTMLElement>(`[data-feedback-key="${escaped}"]`);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width * target.relativeX, y: rect.top + rect.height * target.relativeY };
  }
  return null;
}
