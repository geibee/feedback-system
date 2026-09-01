import type { FeedbackRepositoryPort } from "@geibee/feedback-connector-sdk";
import type { JiraCloudConnectorOptions } from "./connector.js";

export type FeedbackJiraCloudConnectorFactory = (options: JiraCloudConnectorOptions) => FeedbackRepositoryPort;
export const feedbackJiraCloudConnectorKey = "jira-cloud" as const;

export { createFeedbackJiraCloudConnector } from "./connector.js";
export { createJiraCloudFetchTransport } from "./http-transport.js";
export { JiraCloudRestV3Client, normalizeJiraCloudResponse } from "./rest-v3-client.js";
export {
  JiraCloudConnectorProblem,
  JiraCloudRequestCancelledError,
  jiraCloudAttachmentPropertyPrefix,
  jiraCloudMessagePropertyKey,
  jiraCloudRecoveryPropertyKey
} from "./types.js";
export type { JiraCloudConnectorOptions } from "./connector.js";
export type {
  JiraCloudConnectorConfiguration,
  JiraCloudFetch,
  JiraCloudFetchTransportOptions,
  JiraCloudProblemCode,
  JiraCloudRawCandidateMetadata,
  JiraCloudRequest,
  JiraCloudResponse,
  JiraCloudTransport
} from "./types.js";
