import { describe, expect, it } from "vitest";
import { feedbackRedmineConnectorKey } from "./index.js";
import { assertFeedbackConnectorContractFixture } from "@geibee/feedback-connector-sdk/testing";
import { redmineContractFixture } from "./contract-fixture.js";

describe("Redmine Connector contract", () => {
  it("provider keyを維持する", () => {
    expect(feedbackRedmineConnectorKey).toBe("redmine");
  });

  it("provider事実を共通Connector TCKへ適合させる", () => {
    expect(() => assertFeedbackConnectorContractFixture(redmineContractFixture)).not.toThrow();
    expect(redmineContractFixture.capabilities.operationGuarantees).toEqual({
      create: "recoverable",
      reply: "recoverable",
      revision: "best-effort",
      attachmentUpload: "best-effort"
    });
  });
});
