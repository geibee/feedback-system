import type { FeedbackHostAdapter } from "@geibee/core";
import type { FeedbackHostResourceRefV1 } from "./model.js";

export type FeedbackRedmineHostAdapter = Pick<
  FeedbackHostAdapter,
  "getContext" | "getLocation" | "subscribe" | "navigate" | "captureEvidence"
> & {
  getResourceRef(): FeedbackHostResourceRefV1;
  /** 既定URLでは復元できないrouterだけがsame-originのthread URLを返す。 */
  getFeedbackThreadUrl?(threadId: string): string | null;
};
