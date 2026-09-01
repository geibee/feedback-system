import type { FeedbackControllerSnapshot } from "../index.js";

export const controllerSnapshotGolden = {
  schemaVersion: "2",
  lifecycle: "connected",
  pluginLifecycle: "mounted",
  profile: {
    schemaVersion: "2",
    profileId: "inventory-production",
    displayName: "Inventory / Production",
    capabilities: {
      backendOperations: [
        "feedback:read",
        "feedback:create",
        "feedback:reply",
        "feedback:revise",
        "feedback:attachment:read",
        "feedback:attachment:upload"
      ],
      discovery: { workspaces: "supported", resources: "supported" },
      operationGuarantees: {
        create: "recoverable",
        reply: "best-effort",
        revision: "best-effort",
        attachmentUpload: "best-effort"
      },
      creationFields: [],
      maximumAttachmentBytes: 10485760,
      attachmentContentTypes: ["image/png"]
    },
    effectivePermissions: ["feedback:read", "feedback:create", "feedback:attachment:upload"],
    externalNavigationPath: "/internal/feedback/v2/navigation"
  },
  discovery: {
    state: "ready",
    workspaces: [{ workspaceId: "OPS", displayName: "Operations" }],
    selectedWorkspaceId: "OPS",
    resources: [{ resource: { kind: "record", key: "order-001" }, displayName: "Order 001" }],
    selectedResource: { kind: "record", key: "order-001" }
  },
  threads: {
    state: "ready",
    items: [],
    nextCursor: null,
    selected: null,
    refreshing: false,
    error: null
  },
  localState: {
    draft: "再現手順",
    followedThreadIds: ["018f0f58-c3d1-7a2b-8a4f-4c09571e5001"],
    lastViewedByThread: {
      "018f0f58-c3d1-7a2b-8a4f-4c09571e5001": {
        occurredAt: "2026-08-31T06:00:00.000Z",
        eventId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5004"
      }
    },
    unreadCountByThread: {
      "018f0f58-c3d1-7a2b-8a4f-4c09571e5001": 2
    }
  },
  pendingIntents: [{
    scope: {
      profileId: "inventory-production",
      workspaceId: "OPS",
      resource: { kind: "record", key: "order-001" }
    },
    threadId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5001",
    stableResultId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5006",
    intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5002",
    operation: "feedback:attachment:upload",
    requestHash: "sha256:4f2f65f5a90ec7be0abfcae5324f96b5b9574cf43a5f4d31d436098038077e7d",
    recovery: {
      intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5002",
      state: "repair_required",
      operation: "feedback:attachment:upload",
      detail: "結果不明のbinaryは自動再送しません",
      automaticWriteAllowed: false,
      retryDirective: "manual-confirmation"
    },
    retryPolicy: "manual-confirmation"
  }],
  targetSelection: "cancelled",
  capture: "cancelled",
  navigation: {
    requestId: "navigation-1",
    path: "/internal/feedback/v2/navigation",
    state: "requested"
  }
} satisfies FeedbackControllerSnapshot;
