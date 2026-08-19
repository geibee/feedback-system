import { feedbackFeature, type FeedbackFeatureFixture } from "./feedback-redmine.js";

declare global {
  interface Window {
    feedbackFixture: FeedbackFeatureFixture;
  }
}

window.feedbackFixture = feedbackFeature;
