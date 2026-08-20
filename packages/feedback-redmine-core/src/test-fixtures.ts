import type { RedmineConnectorProfile } from "./profile.js";

export const profile: RedmineConnectorProfile = {
  profileId: "inventory-production",
  clientProfile: {
    schemaVersion: "1",
    id: "inventory-production",
    displayName: "Inventory / Production",
    applicationKey: "inventory",
    environmentKey: "production",
    externalWorkspaceKey: "production-review",
    perspectives: [{ code: "ux", label: "UI/UX" }],
    capture: { enabled: true, maximumUploadBytes: 10_485_760, contentTypes: ["image/png", "image/webp"] },
    attachments: { maximumInlinePreviewBytes: 10_485_760, maximumDownloadBytes: 52_428_800 }
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
  showRedmineLink: true
};

export const threadId = "00000000-0000-4000-8000-000000000001";

export function issueFixture(id = 123) {
  return {
    id,
    subject: "[ux] 保存できない",
    description: "最初のコメント\n\n---\nFeedback metadata v1\nThread ID: ignored",
    status: { id: 1, name: "新規", unknown: true },
    priority: { id: 2, name: "通常" },
    assigned_to: { id: 8, name: "担当者" },
    author: { id: 7, name: "投稿者" },
    tracker: { id: 4, name: "Feedback" },
    created_on: "2026-08-19T00:00:00Z",
    updated_on: "2026-08-19T01:00:00Z",
    custom_fields: [
      { id: 21, name: "Feedback Thread ID", value: threadId },
      { id: 22, value: "a".repeat(64) },
      { id: 23, value: "inventory" },
      { id: 24, value: "production" },
      { id: 25, value: "production-review" },
      { id: 26, value: "orders.detail" },
      { id: 27, value: "opaque-resource" },
      { id: 28, value: "ux" },
      {
        id: 29,
        value: JSON.stringify({
          v: "1",
          location: {
            schemaVersion: "1",
            pageKey: "orders.detail",
            routeTemplate: "/orders/{orderId}",
            pathParameters: { orderId: "sha256:value" },
            queryParameters: {}
          },
          target: {
            schemaVersion: "1",
            kind: "screen-position",
            relativeX: 0.5,
            relativeY: 0.5
          }
        })
      },
      { id: 30, value: "00000000-0000-4000-8000-000000000007" },
      { id: 31, value: "利用者" }
    ],
    attachments: [{
      id: 90,
      filename: "../evidence.png",
      filesize: 4,
      content_type: "image/png",
      author: { id: 7, name: "投稿者" },
      created_on: "2026-08-19T00:00:00Z"
    }],
    journals: [
      {
        id: 10,
        user: { id: 9, name: "返信者" },
        notes: "返信です",
        created_on: "2026-08-19T00:30:00Z",
        updated_on: "2026-08-19T00:31:00Z",
        details: [{ property: "attr", name: "status_id", old_value: "1", new_value: "2" }]
      },
      {
        id: 11,
        user: { id: 9, name: "返信者" },
        notes: 42,
        created_on: "2026-08-19T00:40:00Z",
        details: []
      }
    ],
    unknown_from_future_redmine: { value: true }
  };
}
