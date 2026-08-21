import { defineFeedbackManifest, type FeedbackApplicationManifestV1 } from "@geibee/feedback-core";
import feedbackManifest from "../feedback-manifest.json";

/** Web GIS と異なるURL・画面語彙を持つ consumer 2 の正本。 */
export const inventoryFeedbackManifest = defineFeedbackManifest(
  feedbackManifest as unknown as FeedbackApplicationManifestV1
);
