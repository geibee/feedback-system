import type { FeedbackControllerPort } from "@geibee/feedback-controller";

export type FeedbackWebComponentBinding = {
  controller: FeedbackControllerPort;
};

export {
  FeedbackElement,
  defineFeedbackWebComponent,
  feedbackElementName,
  type FeedbackCommandErrorEvent
} from "./element.js";
export {
  createFeedbackPlugin,
  type FeedbackPluginHandle,
  type FeedbackPluginOptions
} from "./plugin.js";
export { feedbackWebComponentStyles } from "./styles.js";

export const feedbackWebComponentContractVersion = "2" as const;
