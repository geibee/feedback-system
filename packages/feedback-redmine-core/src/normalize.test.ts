import { describe, expect, it } from "vitest";
import { normalizeIssueDetail, normalizeIssueSummary, sanitizeFilename } from "./normalize.js";
import { issueFixture, profile, threadId } from "./test-fixtures.js";

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
