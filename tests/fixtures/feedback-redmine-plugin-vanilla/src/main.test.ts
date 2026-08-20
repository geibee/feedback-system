import { describe, expect, it } from "vitest";
import { feedbackFeature } from "./feedback-redmine.js";
import { createQuickstartAdapter } from "./quickstart-adapter.js";
import { FeedbackIntegration } from "./quickstart-react.js";

describe("vanilla consumer", () => {
  it("Reactをhost sourceでimportせずruntime loaderとadapterを構成できる", async () => {
    const adapter = createQuickstartAdapter();
    expect(adapter.getContext().applicationKey).toBe("inventory");
    expect(adapter.getLocation()?.routeTemplate).toBe("/orders/{orderId}");
    expect(adapter.getResourceRef()).toEqual({
      schemaVersion: "1",
      kind: "record",
      key: "order:replace-with-stable-key"
    });
    expect(FeedbackIntegration).toBeTypeOf("function");
    await feedbackFeature.ready();
    expect(feedbackFeature.state()).toBe("disabled");
  });
});
