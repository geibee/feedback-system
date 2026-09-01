import { describe, expect, it } from "vitest";
import { FeedbackOverlay, useFeedbackControllerSnapshot } from "@geibee/feedback-react";
import {
  RedmineFeedbackControllerOverlay,
  useRedmineFeedbackControllerSnapshot
} from "./index.js";

describe("Redmine React v2互換wrapper", () => {
  it("provider固有stateを持たず汎用rendererを同一参照で公開する", () => {
    expect(RedmineFeedbackControllerOverlay).toBe(FeedbackOverlay);
    expect(useRedmineFeedbackControllerSnapshot).toBe(useFeedbackControllerSnapshot);
  });
});
