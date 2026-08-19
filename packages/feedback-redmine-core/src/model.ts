import type {
  FeedbackLocationV1,
  FeedbackTargetV1,
  RedmineAttachmentV1,
  RedmineCapabilitiesV1,
  RedmineClientProfileV1,
  RedmineCurrentPrincipalV1,
  RedmineThreadSummaryV1,
  RedmineThreadV1
} from "@feedback/contracts";

export type {
  RedmineAttachmentV1,
  RedmineCapabilitiesV1,
  RedmineClientProfileV1,
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

export type RedmineThreadListInput = {
  profileId: string;
  resourceRef: FeedbackHostResourceRefV1;
  pageKey: string;
  sort: RedmineThreadSort;
  filter?: RedmineThreadFilter;
  cursor?: string;
};

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
  capturedAt: string;
  evidence: RedmineEvidenceMetadata | null;
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
  nextCursor: string | null;
};
