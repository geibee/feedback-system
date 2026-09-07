import type { FeedbackRepositoryPort } from "@geibee/feedback-connector-sdk";

export type FeedbackRedmineConnectorFactory = () => FeedbackRepositoryPort;
export const feedbackRedmineConnectorKey = "redmine" as const;

export { createFeedbackRedmineConnector } from "./connector.js";
export { mapRedmineIssue, redmineProjectionCandidate } from "./mapper.js";
export {
  assertFeedbackRedmineProfile,
  feedbackRedmineV2ProvisioningFields,
  inspectRedmineV2Provisioning,
  planRedmineV2Provisioning
} from "./provisioning.js";
export { createFeedbackRedmineRestTransport } from "./rest-transport.js";
export type { RedmineFetch, RedmineFetchResponse } from "./rest-transport.js";
export type {
  FeedbackRedmineProfileV2,
  FeedbackRedmineTransportPort,
  RedmineCustomFieldIdsV2,
  RedmineIssueInput,
  RedmineIssueRaw,
  RedmineIssueSearchPage,
  RedmineIssueSummaryRaw,
  RedmineIssueUpdate,
  RedmineProviderCustomField,
  RedmineProvisioningField,
  RedmineV2ProvisioningPlan,
  RedmineUploadReceipt
} from "./redmine-types.js";
