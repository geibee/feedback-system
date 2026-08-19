import { describe, expect, it } from "vitest";
import { createVanillaAdapter, feedbackFeature } from "./feedback-redmine.js";

describe("vanilla consumer", () => {
  it("Reactをhost sourceでimportせず初期disabledのadapterを構成できる", () => {
    const adapter = createVanillaAdapter();
    expect(adapter.getContext().applicationKey).toBe("inventory");
    expect(adapter.getResourceRef()).toEqual({ schemaVersion: "1", kind: "record", key: "fixture-order" });
    expect(feedbackFeature.state()).toBe("disabled");
  });
});
