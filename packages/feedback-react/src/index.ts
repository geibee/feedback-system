import type { FeedbackControllerPort } from "@geibee/feedback-controller";

export type FeedbackReactBinding = {
  controller: FeedbackControllerPort;
};

export {
  FeedbackOverlay,
  useFeedbackControllerSnapshot,
  type FeedbackOverlayHandle,
  type FeedbackOverlayProps
} from "./overlay.js";
export { feedbackReactStyles, installFeedbackReactStyles } from "./styles.js";

export const feedbackReactContractVersion = "2" as const;
