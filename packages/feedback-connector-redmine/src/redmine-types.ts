import type { FeedbackAbortSignal, FeedbackDownloadStream, FeedbackUploadStreamSource } from "@geibee/feedback-connector-sdk";

export type RedmineCustomFieldIdsV2 = {
  threadId: number;
  intentId: number;
  requestHash: number;
  envelope: number;
  projection: number;
  applicationKey: number;
  environmentKey: number;
  externalWorkspaceKey: number;
  hostResourceKey: number;
};

export type FeedbackRedmineProfileV2 = {
  profileId: string;
  installationId: string;
  displayName: string;
  applicationKey: string;
  environmentKey: string;
  workspaceId: string;
  workspaceDisplayName: string;
  projectId: number;
  trackerId: number;
  isPrivate: boolean;
  defaultPriorityId?: number;
  participantId: string;
  participantDisplayName: string;
  customFieldIds: RedmineCustomFieldIdsV2;
  maximumAttachmentBytes: number;
  attachmentContentTypes: readonly string[];
};

export type RedmineCustomFieldValue = { id: number; value: unknown };

export type RedmineIssueInput = {
  project_id: number;
  tracker_id: number;
  subject: string;
  description: string;
  is_private: boolean;
  priority_id?: number;
  custom_fields: RedmineCustomFieldValue[];
};

export type RedmineIssueUpdate = {
  notes?: string;
  custom_fields?: RedmineCustomFieldValue[];
  uploads?: Array<{ token: string; filename: string; content_type: string; description?: string }>;
};

export type RedmineIssueSummaryRaw = {
  id: number;
  subject?: unknown;
  description?: unknown;
  created_on?: unknown;
  updated_on?: unknown;
  status?: unknown;
  author?: unknown;
  custom_fields?: unknown;
};

export type RedmineIssueRaw = RedmineIssueSummaryRaw & {
  journals?: unknown;
  attachments?: unknown;
};

export type RedmineIssueSearchPage = {
  issues: RedmineIssueSummaryRaw[];
  totalCount: number;
  offset: number;
  limit: number;
};

export type RedmineUploadReceipt = {
  token: string;
};

export interface FeedbackRedmineTransportPort {
  searchIssues(query: {
    projectId: number;
    customFieldFilters: Readonly<Record<number, string>>;
    offset: number;
    limit: number;
    order: "updated_desc" | "updated_asc";
  }, signal?: FeedbackAbortSignal): Promise<RedmineIssueSearchPage>;
  getIssue(issueId: number, signal?: FeedbackAbortSignal): Promise<RedmineIssueRaw>;
  createIssue(issue: RedmineIssueInput, signal?: FeedbackAbortSignal): Promise<{ issueId: number }>;
  updateIssue(issueId: number, issue: RedmineIssueUpdate, signal?: FeedbackAbortSignal): Promise<void>;
  upload(source: FeedbackUploadStreamSource, metadata: {
    filename: string;
    contentType: string;
    contentHash: string;
  }, signal?: FeedbackAbortSignal): Promise<RedmineUploadReceipt>;
  downloadAttachment(providerAttachmentId: string, signal?: FeedbackAbortSignal): Promise<FeedbackDownloadStream>;
}

export type RedmineProvisioningField = {
  key: keyof RedmineCustomFieldIdsV2;
  name: string;
  format: "string" | "text";
  searchable: boolean;
};

export type RedmineProviderCustomField = {
  id: number;
  name: string;
  format: "string" | "text" | string;
  searchable: boolean;
};

export type RedmineV2ProvisioningPlan = {
  ready: boolean;
  operations: Array<{
    key: keyof RedmineCustomFieldIdsV2;
    action: "create" | "reuse" | "conflict";
    providerFieldId?: number;
    detail: string;
  }>;
};

export type RedmineProviderObject = {
  issueId: number;
  issue: RedmineIssueRaw;
};
