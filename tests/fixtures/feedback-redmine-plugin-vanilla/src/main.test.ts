import { describe, expect, it } from "vitest";
import { createVanillaAdapter } from "./main.js";

describe("vanilla consumer", () => {
  it("Reactをhost dependencyにせずadapterを構成できる", () => {
    const adapter = createVanillaAdapter();
    expect(adapter.getContext().applicationKey).toBe("inventory");
    expect(adapter.getResourceRef()).toEqual({ schemaVersion: "1", kind: "record", key: "fixture-order" });
  });
});
