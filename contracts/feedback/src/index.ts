import type { components } from "./generated.js";
import type { components as redmineComponents } from "./redmine-gateway.generated.js";

export const feedbackApiVersion = "1.0" as const;
export const feedbackApiMajorVersion = 1 as const;
export const feedbackManifestSchemaVersion = "1" as const;
export const feedbackTargetSchemaVersion = "1" as const;
export const feedbackRedmineContractVersion = "1" as const;

export type FeedbackSubmissionNoticeV1 = {
  message: string;
  link?: {
    url: string;
    label: string;
  };
};

export type RedmineRuntimeConfigV1 = {
  schemaVersion: "1";
  enabled: boolean;
  profileId: string;
  gatewayBasePath: string;
  submissionNotice?: FeedbackSubmissionNoticeV1;
};

export type RedmineInstallationManifestV1 = {
  schemaVersion: "1";
  profileId: string;
  displayName: string;
  applicationKey: string;
  environmentKey: string;
  externalWorkspaceKey: string;
  redmineBaseUrl: string;
  project: { identifier: string; name: string };
  trackerName: string;
  openStatusName: string;
  closedStatusName: string;
  defaultPriorityName: string;
  roleName: string;
  integrationUser: { login: string; firstName: string; lastName: string; mail: string };
  isPrivate: boolean;
  captureEnabled: boolean;
  showRedmineLink: boolean;
  perspectives?: Array<{ code: string; label: string }>;
};

export type RedmineProvisionResultV1 = {
  schemaVersion: "1";
  redmineVersion: string;
  projectId: number;
  trackerId: number;
  openStatusId: number;
  closedStatusId: number;
  defaultPriorityId: number;
  integrationUserId: number;
  customFieldIds: {
    threadId: number;
    requestHash: number;
    applicationKey: number;
    environmentKey: number;
    externalWorkspaceKey: number;
    pageKey: number;
    hostResourceKey: number;
    perspectiveCode: number;
    locator: number;
    submittedById: number;
    submittedByName: number;
  };
};

export type RedmineProvisionPlanV1 = {
  schemaVersion: "1";
  redmineVersion: string;
  profileId: string;
  operations: Array<{ key: string; action: "create" | "reuse"; id?: number; detail: string }>;
  conflicts: Array<{
    key: string;
    id?: number;
    detail: string;
    expected?: Array<[number, number]>;
    actual?: Array<[number, number]>;
  }>;
  planDigest: string;
};

export type RedmineInspectionCheckV1 = {
  key: string;
  status: "ok" | "missing" | "mismatch";
  detail: string;
};

export type RedmineManualInspectionCheckV1 = {
  key: string;
  detail: string;
  status: "unverified" | "accepted";
};

export type RedmineInspectionReportV1 = {
  schemaVersion: "1";
  redmineVersion: string | null;
  principal: { id: number; login: string; admin: boolean } | null;
  checks: RedmineInspectionCheckV1[];
  manualChecks: RedmineManualInspectionCheckV1[];
  manualCheckDigest: string;
  resolvedIds: {
    projectId: number | null;
    trackerId: number | null;
    roleId: number | null;
    integrationUserId: number | null;
    defaultPriorityId: number | null;
    openStatusId: number | null;
    closedStatusIds: number[];
    customFieldIds: Partial<RedmineInspectionCustomFieldIdsV1>;
  };
  generated: {
    clientProfile: RedmineClientProfileV1;
    serverProfile: RedmineInspectionServerProfileV1;
    runtimeConfig: RedmineRuntimeConfigV1;
  } | null;
};

export type RedmineInspectionCustomFieldIdsV1 = {
  threadId: number;
  requestHash: number;
  applicationKey: number;
  environmentKey: number;
  externalWorkspaceKey: number;
  pageKey: number;
  hostResourceKey: number;
  perspectiveCode: number;
  locator: number;
  submittedById: number;
  submittedByName: number;
};

export type RedmineInspectionServerProfileV1 = {
  profileId: string;
  clientProfileRef: "client-profile.json";
  redmineBaseUrl: string;
  projectId: number;
  trackerId: number;
  isPrivate: boolean;
  defaultPriorityId: number | null;
  closedStatusIds: number[];
  customFieldIds: RedmineInspectionCustomFieldIdsV1;
  authorizationMode: "resource-scoped";
  showRedmineLink: boolean;
  secretRef: "FEEDBACK_REDMINE_GATEWAY_API_KEY";
};

export type FeedbackCapabilities = components["schemas"]["FeedbackCapabilities"];
export type FeedbackHostContextV1 = components["schemas"]["FeedbackHostContextV1"];
export type FeedbackApplicationManifestV1 = components["schemas"]["FeedbackApplicationManifestV1"];
export type FeedbackLocationV1 = components["schemas"]["FeedbackLocationV1"];
export type FeedbackTargetV1 = components["schemas"]["FeedbackTargetV1"];
export type FeedbackReviewContextV1 = components["schemas"]["FeedbackReviewContextV1"];
export type FeedbackParticipant = components["schemas"]["FeedbackParticipant"];
export type FeedbackProblem = components["schemas"]["FeedbackProblem"];
export type FeedbackSessionV1 = components["schemas"]["FeedbackSessionV1"];
export type FeedbackThreadV1 = components["schemas"]["FeedbackThreadV1"];
export type FeedbackMessageV1 = components["schemas"]["FeedbackMessageV1"];

export type RedmineClientProfileV1 = redmineComponents["schemas"]["ClientProfile"];
export type RedmineCapabilitiesV1 = redmineComponents["schemas"]["Capabilities"];
export type RedmineCurrentPrincipalV1 = redmineComponents["schemas"]["Principal"];
export type RedmineThreadSummaryV1 = redmineComponents["schemas"]["ThreadSummary"];
export type RedmineThreadV1 = redmineComponents["schemas"]["Thread"];
export type RedmineAttachmentV1 = redmineComponents["schemas"]["Attachment"];
export type RedmineConversationMessageV1 = redmineComponents["schemas"]["ConversationMessage"];
export type RedmineParticipantResultV1 = redmineComponents["schemas"]["ParticipantResult"];
export type RedmineCreateThreadRequestV1 = redmineComponents["schemas"]["CreateThreadRequest"];
export type RedmineCreationOptionsV1 = redmineComponents["schemas"]["CreationOptions"];
export type RedmineCreateMessageRequestV1 = redmineComponents["schemas"]["CreateMessageRequest"];
export type RedmineUpdateMessageRequestV1 = redmineComponents["schemas"]["UpdateMessageRequest"];
export type RedmineProblemV1 = redmineComponents["schemas"]["Problem"];

export type { components, operations, paths } from "./generated.js";
export type {
  components as redmineComponents,
  operations as redmineOperations,
  paths as redminePaths
} from "./redmine-gateway.generated.js";
