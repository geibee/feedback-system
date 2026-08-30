import type { FeedbackTargetV1 } from "@geibee/feedback-core";

export const feedbackElementKeyAttribute = "data-feedback-key";
export const feedbackScrollKeyAttribute = "data-feedback-scroll-key";
export const feedbackDomPositionProvider = "io.github.geibee.feedback.dom";
export const feedbackExcludeAttribute = "data-feedback-exclude";
export const feedbackMaskAttribute = "data-feedback-mask";
export const feedbackMapAttribute = "data-feedback-map";

export function resolveDomFeedbackTarget(input: {
  element: Element | null;
  clientX: number;
  clientY: number;
  viewportWidth?: number;
  viewportHeight?: number;
  scrollX?: number;
  scrollY?: number;
}): FeedbackTargetV1 {
  const keyed = input.element?.closest<HTMLElement>(`[${feedbackElementKeyAttribute}]`) ?? null;
  if (keyed) {
    const key = keyed.getAttribute(feedbackElementKeyAttribute)?.trim();
    const rect = keyed.getBoundingClientRect();
    if (key) {
      return {
        schemaVersion: "1",
        kind: "ui-element",
        elementKey: key,
        relativeX: clamp((input.clientX - rect.left) / Math.max(rect.width, 1)),
        relativeY: clamp((input.clientY - rect.top) / Math.max(rect.height, 1))
      };
    }
  }
  return resolveDomFeedbackPositionTarget(input);
}

function resolveDomFeedbackPositionTarget(input: {
  element: Element | null;
  clientX: number;
  clientY: number;
  viewportWidth?: number;
  viewportHeight?: number;
  scrollX?: number;
  scrollY?: number;
}): Extract<FeedbackTargetV1, { kind: "custom" }> {
  const fallbackRelativeX = clamp(input.clientX / Math.max(1, input.viewportWidth ?? window.innerWidth));
  const fallbackRelativeY = clamp(input.clientY / Math.max(1, input.viewportHeight ?? window.innerHeight));
  const container = input.element?.closest<HTMLElement>(`[${feedbackScrollKeyAttribute}]`) ?? null;
  const containerKey = container?.getAttribute(feedbackScrollKeyAttribute)?.trim();
  if (container && containerKey && Array.from(containerKey).length <= 200) {
    const rect = container.getBoundingClientRect();
    const contentLeft = rect.left + container.clientLeft;
    const contentTop = rect.top + container.clientTop;
    return {
      schemaVersion: "1",
      kind: "custom",
      provider: feedbackDomPositionProvider,
      targetKey: containerKey,
      fallbackRelativeX,
      fallbackRelativeY,
      metadata: {
        coordinateSpace: "scroll-container",
        contentX: Math.max(0, container.scrollLeft + input.clientX - contentLeft),
        contentY: Math.max(0, container.scrollTop + input.clientY - contentTop)
      }
    };
  }
  return {
    schemaVersion: "1",
    kind: "custom",
    provider: feedbackDomPositionProvider,
    targetKey: "document",
    fallbackRelativeX,
    fallbackRelativeY,
    metadata: {
      coordinateSpace: "document",
      documentX: Math.max(0, input.clientX + (input.scrollX ?? window.scrollX)),
      documentY: Math.max(0, input.clientY + (input.scrollY ?? window.scrollY))
    }
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
