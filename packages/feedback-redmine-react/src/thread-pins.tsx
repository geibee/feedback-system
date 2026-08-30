import { useEffect, useMemo, useState } from "react";
import type { RedmineThreadSummaryV1 } from "@geibee/feedback-redmine-core";
import type { FeedbackPinPositionProvider } from "@geibee/feedback-core";
import { feedbackDomPositionProvider } from "@geibee/feedback-react-ui";

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
  const target = value;
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
    target.kind === "custom" &&
    typeof target.fallbackRelativeX === "number" &&
    typeof target.fallbackRelativeY === "number"
  ) {
    const domPosition = resolveDomCustomTargetPosition(target);
    if (domPosition !== undefined) return domPosition;
    return {
      x: target.fallbackRelativeX * document.documentElement.clientWidth,
      y: target.fallbackRelativeY * document.documentElement.clientHeight
    };
  }
  if (
    target.kind === "ui-element" &&
    typeof target.elementKey === "string" &&
    typeof target.relativeX === "number" &&
    typeof target.relativeY === "number"
  ) {
    const element = findKeyedElement("data-feedback-key", target.elementKey);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width * target.relativeX, y: rect.top + rect.height * target.relativeY };
  }
  return null;
}

function resolveDomCustomTargetPosition(
  target: Extract<Parameters<FeedbackPinPositionProvider["getPosition"]>[0], { kind: "custom" }>
): { x: number; y: number } | null | undefined {
  if (target.provider !== feedbackDomPositionProvider || !target.metadata) return undefined;
  const coordinateSpace = target.metadata.coordinateSpace;
  if (coordinateSpace === "document") {
    const documentX = target.metadata.documentX;
    const documentY = target.metadata.documentY;
    if (!isNonNegativeNumber(documentX) || !isNonNegativeNumber(documentY)) return undefined;
    return { x: documentX - window.scrollX, y: documentY - window.scrollY };
  }
  if (coordinateSpace !== "scroll-container") return undefined;
  const contentX = target.metadata.contentX;
  const contentY = target.metadata.contentY;
  if (!isNonNegativeNumber(contentX) || !isNonNegativeNumber(contentY)) return undefined;
  const element = findKeyedElement("data-feedback-scroll-key", target.targetKey);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const contentLeft = rect.left + element.clientLeft;
  const contentTop = rect.top + element.clientTop;
  const position = {
    x: contentLeft + contentX - element.scrollLeft,
    y: contentTop + contentY - element.scrollTop
  };
  const visibleLeft = Math.max(0, contentLeft);
  const visibleTop = Math.max(0, contentTop);
  const visibleRight = Math.min(document.documentElement.clientWidth, contentLeft + element.clientWidth);
  const visibleBottom = Math.min(document.documentElement.clientHeight, contentTop + element.clientHeight);
  return position.x >= visibleLeft && position.x <= visibleRight &&
    position.y >= visibleTop && position.y <= visibleBottom ? position : null;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function findKeyedElement(attribute: string, key: string): HTMLElement | null {
  const escape = (globalThis.CSS as { escape?: (value: string) => string } | undefined)?.escape;
  const escaped = escape ? escape(key) : key.replace(/["\\]/gu, "\\$&");
  return document.querySelector<HTMLElement>(`[${attribute}="${escaped}"]`);
}
