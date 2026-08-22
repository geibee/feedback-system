import type {
  FeedbackLocationV1,
  FeedbackTargetV1,
  RedmineAttachmentV1,
  RedmineCapabilitiesV1,
  RedmineClientProfileV1,
  RedmineCreationOptionsV1,
  RedmineCurrentPrincipalV1,
  RedmineThreadSummaryV1,
  RedmineThreadV1
} from "@geibee/feedback-contracts";

export type {
  RedmineAttachmentV1,
  RedmineCapabilitiesV1,
  RedmineClientProfileV1,
  RedmineCreationOptionsV1,
  RedmineCurrentPrincipalV1,
  RedmineThreadSummaryV1,
  RedmineThreadV1
};

export type FeedbackHostResourceRefV1 = {
  schemaVersion: "1";
  kind: "record" | "page";
  key: string;
};

export type RedmineThreadSort = "created_desc" | "created_asc" | "updated_desc";

export type RedmineThreadFilter = {
  status?: "open" | "closed" | number;
  perspectiveCode?: string;
  assigneeId?: number;
  priorityId?: number;
  q?: string;
};

export type RedmineResourceThreadListInput = {
  profileId: string;
  scope?: "resource";
  resourceRef: FeedbackHostResourceRefV1;
  pageKey: string;
  sort: RedmineThreadSort;
  filter?: RedmineThreadFilter;
  cursor?: string;
};

export type RedmineWorkspaceThreadListInput = {
  profileId: string;
  scope: "workspace";
  sort: RedmineThreadSort;
  filter?: RedmineThreadFilter;
  cursor?: string;
};

export type RedmineThreadListInput = RedmineResourceThreadListInput | RedmineWorkspaceThreadListInput;

export type RedmineThreadLookupInput = {
  profileId: string;
  resourceRef: FeedbackHostResourceRefV1;
  threadId: string;
};

export type RedmineEvidenceMetadata = {
  filename: string;
  contentType: "image/png" | "image/webp";
  byteSize: number;
  sha256: string;
  viewportWidth: number;
  viewportHeight: number;
  pixelRatio: number;
  capturedAt: string;
};

export type RedmineThreadCreateInput = RedmineThreadLookupInput & {
  intentId: string;
  comment: string;
  perspectiveCode: string;
  location: FeedbackLocationV1;
  target: FeedbackTargetV1 | null;
  release: string;
  locale: string;
  /** Redmine issueから同じSPA画面・threadを開くsame-origin URL。 */
  threadUrl?: string | null;
  capturedAt: string;
  evidence: RedmineEvidenceMetadata | null;
  participantName?: string | null;
  parentIssueId?: number;
  dueDate?: string;
  priorityId?: number;
};

export type RedmineMessageCreateInput = RedmineThreadLookupInput & {
  messageId: string;
  intentId: string;
  body: string;
  participantName: string | null;
};

export type RedmineMessageUpdateInput = RedmineThreadLookupInput & {
  messageId: string;
  intentId: string;
  body: string;
  expectedVersion: number;
  participantName: string | null;
};

export type RedmineParticipantV1 = {
  participantId: string;
  credential: string;
};

export type RedmineAttachmentInput = RedmineThreadLookupInput & {
  attachmentId: number;
};

export type RedmineAttachmentContent = {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
  sha256: string;
};

export type RedmineThreadListResult = {
  threads: RedmineThreadSummaryV1[];
  totalCount: number;
  nextCursor: string | null;
};
