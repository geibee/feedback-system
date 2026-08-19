import { describe, expect, it } from "vitest";
import {
  buildLocator,
  buildRedmineDescription,
  buildRedmineSubject,
  calculateRequestHash,
  canonicalJson,
  decodeListCursor,
  encodeListCursor,
  initialCommentFromDescription,
  parseCurrentUserResult,
  parseFeedbackMetadata,
  serializeFeedbackContext,
  validateClientProfile
} from "./index.js";
import { countUnreadReplies, createMemoryClientState, isExpiredPendingIntent } from "./client-state.js";
import { RedmineDiagnosticBuffer } from "./diagnostic.js";
import { validateConnectorProfile } from "./profile.js";
import type { RedmineConnectorProfile, RedmineCustomFieldIds } from "./profile.js";

const clientProfile = {
  schemaVersion: "1" as const,
  id: "inventory-production",
  displayName: "Inventory / Production",
  applicationKey: "inventory",
  environmentKey: "production",
  externalWorkspaceKey: "production-review",
  perspectives: [{ code: "ux", label: "UI/UX" }],
  capture: {
    enabled: true,
    maximumUploadBytes: 10_485_760,
    contentTypes: ["image/png" as const, "image/webp" as const]
  },
  attachments: {
    maximumInlinePreviewBytes: 10_485_760,
    maximumDownloadBytes: 52_428_800
  }
};

const location = {
  schemaVersion: "1" as const,
  pageKey: "orders.detail",
  routeTemplate: "/orders/{orderId}",
  pathParameters: { orderId: "sha256:value" },
  queryParameters: {}
};

const target = {
  schemaVersion: "1" as const,
  kind: "ui-element" as const,
  elementKey: "approve-button",
  relativeX: 0.5,
  relativeY: 0.5
};

describe("Redmine core deterministic model", () => {
  it("gateway principalはhost session由来だけを受ける", () => {
    const principal = {
      subjectId: "subject-1",
      displayName: "利用者",
      redmineUserId: null,
      source: "host-session"
    };
    expect(parseCurrentUserResult({ principal })).toEqual(principal);
    expect(() => parseCurrentUserResult({
      principal: { ...principal, source: "unsupported", redmineUserId: 7 }
    })).toThrow(/principal source/u);
  });

  it("subjectをUnicode scalar 255文字で省略しcontrol文字を除く", () => {
    const subject = buildRedmineSubject({
      comment: `\n \u0000${"😀".repeat(300)}`,
      perspectiveCode: "ux",
      threadId: "00000000-0000-4000-8000-000000000001"
    });
    expect(Array.from(subject)).toHaveLength(255);
    expect(subject.endsWith("…")).toBe(true);
    expect(subject).not.toContain("\u0000");
  });

  it("metadata blockの順序と初回commentを往復する", () => {
    const metadata = {
      threadId: "00000000-0000-4000-8000-000000000001",
      intentId: "00000000-0000-4000-8000-000000000002",
      requestHash: "a".repeat(64),
      applicationKey: "inventory",
      environmentKey: "production",
      externalWorkspaceKey: "production-review",
      pageKey: "orders.detail",
      hostResourceKey: "opaque-resource",
      perspectiveCode: "ux",
      submittedById: "subject-1",
      capturedAt: "2026-08-19T00:00:00Z"
    };
    const description = buildRedmineDescription("最初のコメント", metadata);
    expect(initialCommentFromDescription(description)).toBe("最初のコメント");
    expect(parseFeedbackMetadata(description)).toEqual(metadata);
    expect(description.indexOf("Thread ID:")).toBeLessThan(description.indexOf("Request hash:"));
    expect(description).not.toContain("Submission channel:");
  });

  it("canonical JSONとrequest hashはkey順に依存せず決定的", async () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    const base = {
      threadId: "00000000-0000-4000-8000-000000000001",
      intentId: "00000000-0000-4000-8000-000000000002",
      applicationKey: "inventory",
      environmentKey: "production",
      externalWorkspaceKey: "production-review",
      pageKey: "orders.detail",
      hostResourceKey: "opaque-resource",
      release: "2026.08.19",
      locale: "ja-JP",
      perspectiveCode: "ux",
      location,
      target,
      author: { source: "host-session" as const, subjectId: "subject-1", displayName: "Name", redmineUserId: null },
      comment: "comment",
      evidenceSha256: null
    };
    expect(await calculateRequestHash(base)).toBe(await calculateRequestHash({ ...base, author: { ...base.author, displayName: "別名" } }));
    expect(await calculateRequestHash({ ...base, comment: "changed" })).not.toBe(await calculateRequestHash(base));
  });

  it("locator上限とcontextの2-space/LF形式を固定する", () => {
    expect(buildLocator(location, target)).toBe(canonicalJson({ v: "1", location, target }));
    const bytes = serializeFeedbackContext({
      schemaVersion: "1",
      kind: "feedback-context",
      threadId: "00000000-0000-4000-8000-000000000001",
      intentId: "00000000-0000-4000-8000-000000000002",
      requestHash: "a".repeat(64),
      applicationKey: "inventory",
      environmentKey: "production",
      externalWorkspaceKey: "production-review",
      pageKey: "orders.detail",
      hostResourceKey: "opaque-resource",
      release: "2026.08.19",
      locale: "ja-JP",
      perspectiveCode: "ux",
      location,
      target,
      author: { source: "host-session", subjectId: "subject-1", displayName: null, redmineUserId: null },
      capturedAt: "2026-08-19T00:00:00Z",
      primaryEvidence: null
    });
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('\n  "kind": "feedback-context"');
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("Redmine profileとcursor", () => {
  it("profileのsecret、相関上限、重複code/IDを拒否する", () => {
    expect(validateClientProfile(clientProfile)).toEqual(clientProfile);
    expect(() => validateClientProfile({ ...clientProfile, apiKey: "secret" })).toThrow(/unknown property/u);
    expect(() => validateClientProfile({
      ...clientProfile,
      perspectives: [{ code: "ux", label: "A" }, { code: "ux", label: "B" }]
    })).toThrow(/重複/u);
    expect(() => validateClientProfile({
      ...clientProfile,
      attachments: { maximumInlinePreviewBytes: 2_000_000, maximumDownloadBytes: 1_500_000 }
    })).toThrow(/maximumDownloadBytes/u);

    const ids = Object.fromEntries([
      "threadId", "requestHash", "applicationKey", "environmentKey", "externalWorkspaceKey", "pageKey",
      "hostResourceKey", "perspectiveCode", "locator", "submittedById", "submittedByName"
    ].map((key, index) => [key, index + 1])) as RedmineCustomFieldIds;
    const connector: RedmineConnectorProfile = {
      profileId: clientProfile.id,
      clientProfile,
      redmineBaseUrl: "https://redmine.example.invalid/redmine",
      projectId: 1,
      trackerId: 2,
      isPrivate: true,
      defaultPriorityId: null,
      customFieldIds: ids,
      showRedmineLink: false
    };
    expect(validateConnectorProfile(connector)).toEqual(connector);
    expect(Object.keys(connector.customFieldIds)).toHaveLength(11);
    expect(() => validateConnectorProfile({
      ...connector,
      customFieldIds: { ...connector.customFieldIds, requestHash: connector.customFieldIds.threadId }
    })).toThrow(/重複/u);
    expect(() => validateConnectorProfile({ ...connector, redmineBaseUrl: "https://redmine.example.invalid/a/../b" })).toThrow(/dot segment/u);
  });

  it("cursorをprofile/resource/page/filter/sortへ束縛する", () => {
    const expected = {
      v: "1" as const,
      profileId: "inventory-production",
      hostResourceKey: "opaque-resource",
      pageKey: "orders.detail",
      filter: { status: "open" as const },
      sort: "updated_desc" as const
    };
    const encoded = encodeListCursor({ ...expected, offset: 50 });
    expect(decodeListCursor(encoded, expected).offset).toBe(50);
    expect(() => decodeListCursor(encoded, { ...expected, pageKey: "other.page" })).toThrow(/束縛/u);
  });
});

describe("端末内follow/read state", () => {
  it("follow中の新規replyだけを数え、検証済みcurrent userを除外する", () => {
    const state = {
      schemaVersion: "1" as const,
      profileId: "inventory-production",
      principalScopeHash: "scope",
      threadId: "00000000-0000-4000-8000-000000000001",
      issueId: 123,
      followed: true,
      lastSeenJournalId: 10,
      lastSeenIssueUpdatedOn: "2026-08-19T00:00:00Z",
      updatedAt: "2026-08-19T00:00:00Z"
    };
    expect(countUnreadReplies([
      { id: 10, notes: "既読", authorId: 9 },
      { id: 11, notes: "新規", authorId: 9 },
      { id: 12, notes: "自分", authorId: 7 },
      { id: 13, notes: "   ", authorId: 9 }
    ], state, 7)).toBe(1);
    expect(countUnreadReplies([{ id: 11, notes: "service accountでは除外しない", authorId: 7 }], state, null)).toBe(1);
  });

  it("journal IDが非単調でも既知ID集合から未読を判定し、旧stateは最大IDを使う", () => {
    const state = {
      schemaVersion: "1" as const,
      profileId: "inventory-production",
      principalScopeHash: "a".repeat(64),
      threadId: "00000000-0000-4000-8000-000000000001",
      issueId: 123,
      followed: true,
      lastSeenJournalId: 100,
      seenJournalIds: [10, 100],
      lastSeenIssueUpdatedOn: "2026-08-19T00:00:00Z",
      updatedAt: "2026-08-19T00:00:00Z"
    };
    const journals = [
      { id: 10, notes: "既読", authorId: 9 },
      { id: 50, notes: "後から現れた非単調ID", authorId: 9 }
    ];
    expect(countUnreadReplies(journals, state, 7)).toBe(1);
    const { seenJournalIds: _seenJournalIds, ...legacyState } = state;
    expect(countUnreadReplies(journals, legacyState, 7)).toBe(0);
  });

  it("memory stateをprofile/principal/thread namespaceで分離する", async () => {
    const storage = createMemoryClientState();
    const state = {
      schemaVersion: "1" as const,
      profileId: "inventory-production",
      principalScopeHash: "a".repeat(64),
      threadId: "00000000-0000-4000-8000-000000000001",
      issueId: 123,
      followed: true,
      lastSeenJournalId: 10,
      lastSeenIssueUpdatedOn: "2026-08-19T00:00:00Z",
      updatedAt: "2026-08-19T00:00:00Z"
    };
    await storage.setFollowState(state);
    expect(await storage.getFollowState(state.profileId, "a".repeat(64), state.threadId)).toEqual(state);
    expect(await storage.getFollowState(state.profileId, "b".repeat(64), state.threadId)).toBeNull();
    await storage.setDraft(state.profileId, "a".repeat(64), "利用者Aのdraft");
    expect(await storage.getDraft(state.profileId, "a".repeat(64))).toBe("利用者Aのdraft");
    expect(await storage.getDraft(state.profileId, "b".repeat(64))).toBeNull();
  });

  it("pending intentを利用者scopeで分離し7日後に失効する", async () => {
    const storage = createMemoryClientState();
    const intent = {
      schemaVersion: "1" as const,
      profileId: "inventory-production",
      threadId: "00000000-0000-4000-8000-000000000001",
      intentId: "00000000-0000-4000-8000-000000000002",
      clientDraftHash: "a".repeat(64),
      createdAt: "2000-01-01T00:00:00Z",
      state: "uncertain" as const
    };
    expect(isExpiredPendingIntent(intent, Date.parse("2000-01-08T00:00:00Z"))).toBe(false);
    expect(isExpiredPendingIntent(intent, Date.parse("2000-01-08T00:00:00.001Z"))).toBe(true);
    await storage.setPendingIntent(intent.profileId, "a".repeat(64), intent);
    expect(await storage.getPendingIntent(intent.profileId, "a".repeat(64))).toBeNull();
    expect(await storage.getPendingIntent(intent.profileId, "b".repeat(64))).toBeNull();
  });
});

describe("local diagnostic", () => {
  it("100件ring bufferへ許可fieldだけを保持する", () => {
    const diagnostics = new RedmineDiagnosticBuffer();
    for (let index = 0; index < 101; index += 1) diagnostics.record({
      requestId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      operation: "redmine.thread.list.v1",
      profileId: "inventory-production",
      httpStatus: 200,
      durationMilliseconds: index + 0.123,
      errorCode: null
    });
    const document = diagnostics.document("2026-08-19T00:00:00Z");
    expect(document.entries).toHaveLength(100);
    expect(document.entries[0]?.requestId).toBe("00000000-0000-4000-8000-000000000001");
    expect(JSON.stringify(document)).not.toMatch(/body|filename|apiKey|threadId|principal/u);
    expect(() => diagnostics.record({
      ...document.entries[0]!,
      operation: "arbitrary business operation"
    })).toThrow(/operation/u);
  });
});
