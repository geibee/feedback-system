import { assertFeedbackConnectorContractFixture } from "@geibee/feedback-connector-sdk/testing";
import { describe, expect, it } from "vitest";
import { backlogContractFixture } from "./contract-fixture.js";

describe("Backlog Connector contract", () => {
  it("既存Connector TCKを変更せず通過する", () => {
    expect(() => assertFeedbackConnectorContractFixture(backlogContractFixture)).not.toThrow();
    expect(backlogContractFixture.capabilities.backendOperations).not.toContain("feedback:attachment:upload");
  });
});
