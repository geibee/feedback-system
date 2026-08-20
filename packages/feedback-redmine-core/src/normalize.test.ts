import { describe, expect, it } from "vitest";
import { normalizeIssueDetail, normalizeIssueSummary, sanitizeFilename } from "./normalize.js";
import { issueFixture, profile, threadId } from "./test-fixtures.js";
import { buildRedmineDescription, buildRedmineMessageNote } from "./marker.js";
import type { RedmineIssueDto } from "./redmine-dto.js";

describe("Redmine DTO normalization", () => {
  it("unknown fieldを無視して一覧の最初のcommentとlocatorを作る", () => {
    const summary = normalizeIssueSummary(issueFixture(), profile);
    expect(summary.threadId).toBe(threadId);
    expect(summary.initialComment).toBe("最初のコメント");
    expect(summary.status.name).toBe("新規");
    expect(summary.locator?.location.pageKey).toBe("orders.detail");
    expect(summary.hasAttachments).toBe(true);
  });

  it("notesとfield detailを両方表示しmalformed journalだけdiagnosticにする", () => {
    const thread = normalizeIssueDetail(issueFixture(), profile, "https://redmine.example.invalid/redmine/issues/123");
    expect(thread.timeline.map((item) => item.kind)).toEqual(["reply", "activity", "diagnostic"]);
    expect(thread.latestReply).toBe("返信です");
    expect(thread.diagnosticCount).toBe(1);
    expect(thread.attachments[0]?.filename).toBe("evidence.png");
  });

  it("thread UUIDを含む規約filenameをprimary evidenceとして復元する", () => {
    const issue = issueFixture();
    issue.attachments[0]!.filename = `feedback-${threadId}.png`;
    expect(normalizeIssueDetail(issue, profile, null).attachments[0]?.primaryEvidence).toBe(true);
  });

  it("participant replyと追記型edit journalをversion履歴へfoldする", () => {
    const participantId = "00000000-0000-4000-8000-000000000007";
    const messageId = "00000000-0000-4000-8000-000000000008";
    const issue: RedmineIssueDto = issueFixture();
    issue.description = buildRedmineDescription("最初のコメント", {
      threadId,
      intentId: "00000000-0000-4000-8000-000000000002",
      requestHash: "a".repeat(64),
      applicationKey: "inventory",
      environmentKey: "production",
      externalWorkspaceKey: "production-review",
      pageKey: "orders.detail",
      hostResourceKey: "opaque-resource",
      perspectiveCode: "ux",
      submittedById: participantId,
      submittedByName: "利用者",
      messageId: threadId,
      participantId,
      messageSignature: "signature",
      capturedAt: "2026-08-19T00:00:00Z"
    });
    issue.journals = [{
      id: 12,
      user: { id: 7, name: "Integration" },
      notes: buildRedmineMessageNote("返信 v1", {
        kind: "reply", messageId, participantId, participantName: "利用者", version: 1,
        intentId: "00000000-0000-4000-8000-000000000003", signature: "signature"
      }),
      created_on: "2026-08-19T00:30:00Z",
      details: []
    }, {
      id: 13,
      user: { id: 7, name: "Integration" },
      notes: buildRedmineMessageNote("返信 v2", {
        kind: "edit", messageId, participantId, participantName: "利用者", version: 2,
        intentId: "00000000-0000-4000-8000-000000000004", signature: "signature"
      }),
      created_on: "2026-08-19T00:40:00Z",
      details: []
    }];
    const thread = normalizeIssueDetail(issue, profile, null, participantId);
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages?.[0]).toMatchObject({ kind: "initial", canEdit: true });
    expect(thread.messages?.[1]).toMatchObject({ body: "返信 v2", version: 2, canEdit: true });
    expect(thread.messages?.[1]?.versions.map((version) => version.body)).toEqual(["返信 v1", "返信 v2"]);
  });

  it("inline preview上限を超える画像をdownload-onlyにする", () => {
    const issue = issueFixture();
    issue.attachments[0]!.filesize = profile.clientProfile.attachments.maximumInlinePreviewBytes + 1;
    expect(normalizeIssueDetail(issue, profile, null).attachments[0]?.inlinePreview).toBe(false);
  });

  it("壊れたlocatorはthread自体を捨てずnullにする", () => {
    const issue = issueFixture();
    issue.custom_fields.find((field) => field.id === 29)!.value = "{invalid";
    expect(normalizeIssueSummary(issue, profile).locator).toBeNull();
  });

  it("必須issue field欠落はfail-closedする", () => {
    const issue = issueFixture() as Record<string, unknown>;
    delete issue.status;
    expect(() => normalizeIssueSummary(issue, profile)).toThrow(/issue.status/u);
  });

  it("filenameのpath/control文字を除く", () => {
    expect(sanitizeFilename("../folder\\name\u0000.png")).toBe("name_.png");
  });
});
