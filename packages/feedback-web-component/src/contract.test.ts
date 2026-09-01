import { describe, expect, it } from "vitest";
import { feedbackWebComponentContractVersion } from "./index.js";

describe("Web Component renderer contract", () => {
  it("controller contractだけへ接続する", () => {
    expect(feedbackWebComponentContractVersion).toBe("2");
  });
});
