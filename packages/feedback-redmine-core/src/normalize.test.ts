import { describe, expect, it } from "vitest";
import { normalizeIssueDetail, normalizeIssueSummary, sanitizeFilename } from "./normalize.js";
import { issueFixture, profile, threadId } from "./test-fixtures.js";
import { buildRedmineDescription, buildRedmineMessageNote } from "./marker.js";
import { parseThreadSummary } from "./response-validation.js";
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
    issue.description = `最初のコメント\n\n---\nFeedback metadata v1\n` +
      `Intent ID: 00000000-0000-4000-8000-000000000002\n` +
      `Submitted by name: 利用者\nMessage ID: ${threadId}\nParticipant ID: ${participantId}\nMessage signature: signature`;
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

  it("新規descriptionではcontext attachmentとcustom fieldから初回投稿者を復元する", () => {
    const participantId = "00000000-0000-4000-8000-000000000007";
    const issue = issueFixture();
    issue.description = buildRedmineDescription(
      "最初のコメント",
      `https://inventory.example.invalid/orders/1?feedbackThread=${threadId}`
    );
    issue.attachments.push({
      id: 91,
      filename: "feedback-context-v1.json",
      filesize: 512,
      content_type: "application/json",
      author: { id: 7, name: "投稿者" },
      created_on: "2026-08-19T00:00:00Z"
    });
    const thread = normalizeIssueDetail(issue, profile, null, participantId);
    expect(thread.initialComment).toBe("最初のコメント");
    expect(thread.messages?.[0]).toMatchObject({
      id: threadId,
      canEdit: true,
      author: { kind: "participant", participantId, displayName: "利用者" }
    });
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

  it("custom targetをlocatorから制約どおり復元する", () => {
    const issue = issueFixture();
    const field = issue.custom_fields.find((entry) => entry.id === 29)!;
    const locator = JSON.parse(field.value as string) as Record<string, unknown>;
    locator.target = {
      schemaVersion: "1",
      kind: "custom",
      provider: "com.example.threejs",
      targetKey: "model-42",
      fallbackRelativeX: 0.25,
      fallbackRelativeY: 0.75,
      metadata: { layerName: "equipment", level: 3 }
    };
    field.value = JSON.stringify(locator);
    const summary = normalizeIssueSummary(issue, profile);
    expect(summary.locator?.target).toEqual(locator.target);
    expect(parseThreadSummary(summary).locator?.target).toEqual(locator.target);

    const invalidResponse = structuredClone(summary) as unknown as Record<string, unknown>;
    const invalidLocator = invalidResponse.locator as Record<string, unknown>;
    (invalidLocator.target as Record<string, unknown>).metadata = { nested: { rejected: true } };
    expect(() => parseThreadSummary(invalidResponse)).toThrow(/custom target metadata value/u);

    (locator.target as Record<string, unknown>).metadata = { nested: { rejected: true } };
    field.value = JSON.stringify(locator);
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
