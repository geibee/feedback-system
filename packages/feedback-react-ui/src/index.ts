import type { FeedbackTargetV1 } from "@geibee/feedback-core";

export const feedbackElementKeyAttribute = "data-feedback-key";
export const feedbackExcludeAttribute = "data-feedback-exclude";
export const feedbackMaskAttribute = "data-feedback-mask";
export const feedbackMapAttribute = "data-feedback-map";

export function resolveDomFeedbackTarget(input: {
  element: Element | null;
  clientX: number;
  clientY: number;
  viewportWidth?: number;
  viewportHeight?: number;
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
  return {
    schemaVersion: "1",
    kind: "screen-position",
    relativeX: clamp(input.clientX / Math.max(1, input.viewportWidth ?? window.innerWidth)),
    relativeY: clamp(input.clientY / Math.max(1, input.viewportHeight ?? window.innerHeight))
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
