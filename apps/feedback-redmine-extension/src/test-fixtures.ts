import type { ExtensionProfileV1, ExtensionProfilesV1 } from "./profile.js";

export const extensionProfile: ExtensionProfileV1 = {
  id: "inventory-production",
  displayName: "Inventory / Production",
  applicationKey: "inventory",
  environmentKey: "production",
  externalWorkspaceKey: "production-review",
  hostOrigins: ["https://inventory.example.invalid"],
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
    submittedByName: 31,
    submissionChannel: 32
  },
  perspectives: [{ code: "ux", label: "UI/UX" }],
  capture: { enabled: true, maximumUploadBytes: 1_048_576, contentTypes: ["image/png"] },
  attachments: { maximumInlinePreviewBytes: 1_048_576, maximumDownloadBytes: 1_048_576 },
  showRedmineLink: false
};

export const extensionProfiles: ExtensionProfilesV1 = { schemaVersion: "1", profiles: [extensionProfile] };
