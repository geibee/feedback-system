import { describe, expect, it } from "vitest";
import { feedbackJiraCloudConnectorKey } from "./index.js";
import { assertFeedbackConnectorContractFixture } from "@geibee/feedback-connector-sdk/testing";
import { jiraCloudContractFixture } from "./contract-fixture.js";

describe("Jira Cloud Connector skeleton", () => {
  it("Cloudだけを初期provider keyとして固定する", () => {
    expect(feedbackJiraCloudConnectorKey).toBe("jira-cloud");
  });

  it("provider事実を共通Connector TCKへ適合させる", () => {
    expect(() => assertFeedbackConnectorContractFixture(jiraCloudContractFixture)).not.toThrow();
    expect(jiraCloudContractFixture.operations.attachmentUpload.automaticBinaryRetry).toBe(false);
  });
});
