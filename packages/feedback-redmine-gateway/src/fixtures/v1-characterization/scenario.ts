import type { GatewayServerProfile } from "../../profile.js";

export const profileId = "inventory-production";
export const threadId = "00000000-0000-4000-8000-000000000001";
export const createThreadId = "00000000-0000-4000-8000-000000000002";
export const createIntentId = "00000000-0000-4000-8000-000000000003";
export const replyMessageId = "00000000-0000-4000-8000-000000000004";
export const replyIntentId = "00000000-0000-4000-8000-000000000005";
export const editIntentId = "00000000-0000-4000-8000-000000000006";
export const ownerBrowserProfileId = "00000000-0000-4000-8000-000000000007";
export const otherBrowserProfileId = "00000000-0000-4000-8000-000000000008";

export const participantSigningKey = "participant-signing-test-secret-at-least-32-bytes";
export const redmineApiKey = "server-side-redmine-characterization-key";

export const profile: GatewayServerProfile = {
  profileId,
  clientProfile: {
    schemaVersion: "1",
    id: profileId,
    displayName: "Inventory / Production",
    applicationKey: "inventory",
    environmentKey: "production",
    externalWorkspaceKey: "production-review",
    perspectives: [{ code: "ux", label: "UI/UX" }],
    capture: {
      enabled: true,
      maximumUploadBytes: 10_485_760,
      contentTypes: ["image/png", "image/webp"]
    },
    attachments: {
      maximumInlinePreviewBytes: 10_485_760,
      maximumDownloadBytes: 52_428_800
    }
  },
  redmineBaseUrl: "https://redmine.example.invalid/redmine",
  projectId: 12,
  trackerId: 4,
  isPrivate: true,
  defaultPriorityId: 2,
  customFieldIds: {
    threadId: 21,
    requestHash: 22,
    applicationKey: 23,
    environmentKey: 24,
    externalWorkspaceKey: 25,
    pageKey: 26,
    hostResourceKey: 27,
    perspectiveCode: 28,
    locator: 29,
    submittedById: 30,
    submittedByName: 31
  },
  showRedmineLink: false,
  closedStatusIds: [5],
  authorizationMode: "resource-scoped",
  secretRef: "FEEDBACK_REDMINE_GATEWAY_API_KEY"
};

export const location = {
  schemaVersion: "1" as const,
  pageKey: "orders.detail",
  routeTemplate: "/orders/{orderId}",
  pathParameters: { orderId: "sha256:order-1" }
};

export const target = {
  schemaVersion: "1" as const,
  kind: "screen-position" as const,
  relativeX: 0.25,
  relativeY: 0.75
};

export const gatewayRequests = {
  profile: {
    method: "GET",
    path: `/internal/feedback-redmine/v1/profiles/${profileId}`,
    headers: {}
  },
  list: {
    method: "GET",
    path: `/internal/feedback-redmine/v1/profiles/${profileId}/threads` +
      "?resourceKind=record&resourceKey=order-1&pageKey=orders.detail&sort=updated_desc",
    headers: {}
  },
  detail: {
    method: "GET",
    path: `/internal/feedback-redmine/v1/profiles/${profileId}/threads/${threadId}` +
      "?resourceKind=record&resourceKey=order-1",
    headers: {}
  },
  create: {
    method: "POST",
    path: `/internal/feedback-redmine/v1/profiles/${profileId}/threads`,
    headers: { "Idempotency-Key": createIntentId },
    body: {
      resourceRef: { schemaVersion: "1", kind: "record", key: "order-1" },
      threadId: createThreadId,
      intentId: createIntentId,
      comment: "新しいフィードバック",
      perspectiveCode: "ux",
      location,
      target,
      release: "2026.08.31",
      locale: "ja-JP",
      threadUrl: `https://app.example/orders/1?feedbackThread=${createThreadId}`,
      capturedAt: "2026-08-31T01:00:00Z",
      evidence: null,
      participantName: "利用者A"
    }
  },
  reply: {
    method: "POST",
    path: `/internal/feedback-redmine/v1/profiles/${profileId}/threads/${threadId}/messages`,
    headers: { "Content-Type": "application/json", "Idempotency-Key": replyIntentId },
    body: { messageId: replyMessageId, body: "確認しました", participantName: "利用者A" }
  },
  edit: {
    method: "PATCH",
    path: `/internal/feedback-redmine/v1/profiles/${profileId}/threads/${threadId}/messages/${replyMessageId}`,
    headers: { "Content-Type": "application/json", "Idempotency-Key": editIntentId },
    body: { body: "確認して修正しました", expectedVersion: 1, participantName: "利用者A" }
  },
  attachment: {
    method: "GET",
    path: `/internal/feedback-redmine/v1/profiles/${profileId}/threads/${threadId}/attachments/501` +
      "?resourceKind=record&resourceKey=order-1",
    headers: {}
  }
} as const;

export const locator = { v: "1" as const, location, target };

export const attachmentBytes = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10,
  0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 1, 0, 0, 0, 1
]);

export const attachmentSha256 = "a930c2bb4e61c0682068f71c4ef427eefbb07098ecea9390e445e7af4b66a384";

export const existingIssue = {
  id: 123,
  subject: "[ux] 初回投稿",
  description: "初回投稿",
  status: { id: 1, name: "新規" },
  priority: { id: 2, name: "通常" },
  author: { id: 7, name: "Feedback Integration" },
  tracker: { id: 4, name: "Feedback" },
  created_on: "2026-08-31T00:00:00Z",
  updated_on: "2026-08-31T00:00:00Z",
  custom_fields: [
    { id: 21, value: threadId },
    { id: 22, value: "a".repeat(64) },
    { id: 23, value: "inventory" },
    { id: 24, value: "production" },
    { id: 25, value: "production-review" },
    { id: 26, value: "orders.detail" },
    { id: 27, value: "order-1" },
    { id: 28, value: "ux" },
    { id: 29, value: JSON.stringify(locator) },
    { id: 30, value: "00000000-0000-4000-8000-000000000099" },
    { id: 31, value: "利用者" }
  ],
  attachments: [{
    id: 501,
    filename: "evidence.png",
    filesize: attachmentBytes.byteLength,
    content_type: "image/png",
    content_url: "https://redmine.example.invalid/redmine/attachments/download/501/evidence.png",
    author: { id: 7, name: "Feedback Integration" },
    created_on: "2026-08-31T00:01:00Z"
  }],
  journals: []
};

export const expectedSummary = {
  threadId,
  issueId: 123,
  subject: "[ux] 初回投稿",
  initialComment: "初回投稿",
  latestReply: null,
  status: { id: 1, name: "新規" },
  priority: { id: 2, name: "通常" },
  assignee: null,
  author: { id: 7, name: "Feedback Integration" },
  perspectiveCode: "ux",
  locator,
  hasAttachments: true,
  createdAt: "2026-08-31T00:00:00Z",
  updatedAt: "2026-08-31T00:00:00Z",
  closed: false
};
