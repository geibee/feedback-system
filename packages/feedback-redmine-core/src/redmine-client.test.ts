import { describe, expect, it } from "vitest";
import { RedmineFeedbackError } from "./errors.js";
import { issueFixture, profile, threadId } from "./test-fixtures.js";
import { RedmineTrustedClient, validateAttachmentContentUrl, type RedmineFetch } from "./redmine-client.js";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" }
});

const createInput = {
  profileId: profile.profileId,
  hostResourceKey: "opaque-resource",
  threadId,
  intentId: "00000000-0000-4000-8000-000000000002",
  comment: "最初のコメント",
  perspectiveCode: "ux",
  location: {
    schemaVersion: "1" as const,
    pageKey: "orders.detail",
    routeTemplate: "/orders/{orderId}",
    pathParameters: { orderId: "sha256:value" },
    queryParameters: {}
  },
  target: null,
  release: "2026.08.19",
  locale: "ja-JP",
  threadUrl: `https://inventory.example.invalid/orders/value?feedbackThread=${threadId}`,
  capturedAt: "2026-08-19T00:00:00Z",
  evidence: null,
  author: {
    source: "participant-credential" as const,
    participantId: "00000000-0000-4000-8000-000000000007",
    displayName: "利用者"
  }
};

function client(fetch: RedmineFetch) {
  return new RedmineTrustedClient({ profile, apiKey: "test-user-key", fetch, delay: async () => undefined });
}

describe("Redmine trusted HTTP policy", () => {
  it("一覧queryへ固定scope、status、sort、limitを常に付ける", async () => {
    let requested = "";
    const result = await client(async (url, init) => {
      requested = url;
      expect(init.method).toBe("GET");
      expect(new Headers(init.headers).get("X-Redmine-API-Key")).toBe("test-user-key");
      expect(init.redirect).toBe("error");
      return json({ issues: [issueFixture()], total_count: 1, offset: 0, limit: 100 });
    }).listThreads({
      hostResourceKey: "opaque-resource",
      pageKey: "orders.detail",
      sort: "updated_desc",
      filter: { status: "open", perspectiveCode: "ux", assigneeId: 8, priorityId: 2 },
      offset: 0
    });
    const query = new URL(requested).searchParams;
    expect(query.get("project_id")).toBe("12");
    expect(query.get("tracker_id")).toBe("4");
    expect(query.get("status_id")).toBe("open");
    expect(query.get("sort")).toBe("updated_on:desc");
    expect(query.get("limit")).toBe("100");
    expect(query.get("cf_23")).toBe("inventory");
    expect(query.get("cf_27")).toBe("opaque-resource");
    expect(result.threads).toHaveLength(1);
    expect(result.nextOffset).toBeNull();
  });

  it("client-side検索でRedmine pageを結合し、走査済みoffsetからcursorを再開する", async () => {
    const issues = Array.from({ length: 180 }, (_, index) => ({
      ...issueFixture(index + 1),
      subject: index < 10 || (index >= 100 && index < 140) ? `needle ${index}` : `other ${index}`
    }));
    const offsets: number[] = [];
    const first = await client(async (url) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      offsets.push(offset);
      return json({ issues: issues.slice(offset, offset + 100), total_count: issues.length, offset, limit: 100 });
    }).listThreads({
      hostResourceKey: "opaque-resource",
      pageKey: "orders.detail",
      sort: "updated_desc",
      filter: { q: "needle" },
      offset: 0
    });
    expect(offsets).toEqual([0, 100]);
    expect(first.threads).toHaveLength(50);
    expect(first.nextOffset).toBe(140);

    offsets.length = 0;
    const last = await client(async (url) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      offsets.push(offset);
      return json({ issues: issues.slice(offset, offset + 100), total_count: issues.length, offset, limit: 100 });
    }).listThreads({
      hostResourceKey: "opaque-resource",
      pageKey: "orders.detail",
      sort: "updated_desc",
      filter: { q: "needle" },
      offset: first.nextOffset!
    });
    expect(offsets).toEqual([140]);
    expect(last.threads).toHaveLength(0);
    expect(last.nextOffset).toBeNull();
  });

  it("GETだけ429/5xxを最大2回retryする", async () => {
    let calls = 0;
    const current = await client(async () => {
      calls += 1;
      return calls < 3 ? json({}, 503) : json({ user: { id: 7, firstname: "Taro", lastname: "Yamada" } });
    }).getCurrentUser();
    expect(calls).toBe(3);
    expect(current).toEqual({ id: 7, name: "Taro Yamada" });
  });

  it("current user・project・必須custom fieldを非破壊で検証する", async () => {
    const paths: string[] = [];
    const result = await client(async (url) => {
      const parsed = new URL(url);
      paths.push(parsed.pathname);
      if (parsed.pathname.endsWith("/users/current.json")) {
        return json({ user: { id: 7, firstname: "Taro", lastname: "Yamada" } });
      }
      if (parsed.pathname.endsWith("/projects/12.json")) return json({ project: { id: 12, name: "Feedback" } });
      if (parsed.pathname.endsWith("/issues.json")) {
        expect(parsed.searchParams.get("project_id")).toBe("12");
        expect(parsed.searchParams.get("tracker_id")).toBe("4");
        expect(parsed.searchParams.get("limit")).toBe("1");
        return json({ issues: [issueFixture()], total_count: 1, offset: 0, limit: 1 });
      }
      throw new Error(`unexpected request: ${url}`);
    }).validateConnection();
    expect(paths).toEqual([
      "/redmine/users/current.json",
      "/redmine/projects/12.json",
      "/redmine/issues.json"
    ]);
    expect(result).toEqual({
      user: { id: 7, name: "Taro Yamada" },
      projectId: 12,
      customFields: "verified"
    });
  });

  it("検証対象issueが0件ならcustom fieldを未証明として扱う", async () => {
    const result = await client(async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/users/current.json")) return json({ user: { id: 7, login: "user" } });
      if (path.endsWith("/projects/12.json")) return json({ project: { id: 12 } });
      return json({ issues: [], total_count: 0, offset: 0, limit: 1 });
    }).validateConnection();
    expect(result.customFields).toBe("not-yet-proven");
  });

  it("active priorityだけを列挙し、親チケットを固定projectへ制限する", async () => {
    const trusted = client(async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/enumerations/issue_priorities.json")) return json({
        issue_priorities: [{ id: 2, name: "通常", active: true }, { id: 3, name: "廃止", active: false }]
      });
      if (path.endsWith("/issues/100.json")) return json({ issue: { id: 100, project: { id: 12, name: "Feedback" } } });
      if (path.endsWith("/issues/101.json")) return json({ issue: { id: 101, project: { id: 99, name: "別project" } } });
      throw new Error(`unexpected request: ${url}`);
    });
    expect(await trusted.listIssuePriorities()).toEqual([{ id: 2, name: "通常" }]);
    await expect(trusted.validateParentIssue(100)).resolves.toBeUndefined();
    await expect(trusted.validateParentIssue(101)).rejects.toMatchObject({
      code: "redmine.validation_failed",
      upstreamStatus: 422
    });
  });

  it.each([
    [401, "redmine.invalid_api_key"],
    [403, "redmine.permission_denied"],
    [404, "redmine.not_found"],
    [406, "redmine.content_type_rejected"],
    [413, "redmine.payload_too_large"],
    [422, "redmine.validation_failed"],
    [429, "redmine.rate_limited"],
    [503, "redmine.unavailable"]
  ])("HTTP %iをsanitized problem code %sへ写像する", async (status, code) => {
    let caught: unknown;
    try {
      await client(async () => json({ secret: "upstream body" }, status)).getCurrentUser();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RedmineFeedbackError);
    expect((caught as RedmineFeedbackError).code).toBe(code);
    expect((caught as Error).message).not.toContain("upstream body");
  });

  it("POST create失敗時にblind retryせずthread検索だけで回収を試みる", async () => {
    let createCalls = 0;
    let searchCalls = 0;
    const fetch: RedmineFetch = async (url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/issues.json") && init.method === "GET") {
        searchCalls += 1;
        return json({ issues: [], total_count: 0, offset: 0, limit: 100 });
      }
      if (path.endsWith("/uploads.json")) return json({ upload: { token: "upload-token" } }, 201);
      if (path.endsWith("/issues.json") && init.method === "POST") {
        createCalls += 1;
        throw new TypeError("connection reset");
      }
      throw new Error(`unexpected request: ${init.method} ${url}`);
    };
    await expect(client(fetch).createThread(createInput, null)).rejects.toMatchObject({ code: "redmine.unavailable" });
    expect(createCalls).toBe(1);
    expect(searchCalls).toBe(3);
  });

  it.each([false, true])("upload tokenをissue createへ渡し、結果不明=%sでも既存issueへ収束する", async (unknownResult) => {
    const optionalInput = { ...createInput, parentIssueId: 100, dueDate: "2026-08-31", priorityId: 4 };
    let createdIssue: ReturnType<typeof issueFixture> | null = null;
    let createCalls = 0;
    let contextUploads = 0;
    const fetch: RedmineFetch = async (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/uploads.json")) {
        contextUploads += 1;
        expect(parsed.searchParams.get("filename")).toBe("feedback-context-v1.json");
        return json({ upload: { token: "context-upload-token" } }, 201);
      }
      if (parsed.pathname.endsWith("/issues.json") && init.method === "POST") {
        createCalls += 1;
        const request = JSON.parse(init.body as string) as { issue: ReturnType<typeof issueFixture> & {
          uploads: unknown[];
          parent_issue_id: number;
          due_date: string;
          priority_id: number;
        } };
        expect(request.issue.uploads).toEqual([expect.objectContaining({ token: "context-upload-token" })]);
        expect(request.issue.custom_fields).toEqual(expect.arrayContaining([
          { id: profile.customFieldIds.submittedById, value: "00000000-0000-4000-8000-000000000007" }
        ]));
        expect(request.issue.custom_fields).toHaveLength(11);
        expect(request.issue.description).toContain(createInput.threadUrl);
        expect(request.issue.description).not.toContain("Feedback metadata v1");
        expect(request.issue.description).not.toContain("Application:");
        expect(request.issue).toMatchObject({ parent_issue_id: 100, due_date: "2026-08-31", priority_id: 4 });
        createdIssue = {
          ...issueFixture(),
          subject: request.issue.subject,
          description: request.issue.description,
          custom_fields: request.issue.custom_fields
        };
        if (unknownResult) throw new TypeError("connection reset after commit");
        return json({ issue: { id: 123 } }, 201);
      }
      if (parsed.pathname.endsWith("/issues.json")) {
        return json({
          issues: createdIssue ? [createdIssue] : [],
          total_count: createdIssue ? 1 : 0,
          offset: 0,
          limit: 100
        });
      }
      if (parsed.pathname.endsWith("/issues/123.json") && createdIssue) return json({ issue: createdIssue });
      throw new Error(`unexpected request: ${init.method} ${url}`);
    };
    const created = await client(fetch).createThreadWithDisposition(optionalInput, null);
    expect(created.thread.threadId).toBe(threadId);
    expect(created.thread.initialComment).toBe("最初のコメント");
    expect(created.disposition).toBe(unknownResult ? "recovered" : "created");
    expect(createCalls).toBe(1);
    expect(contextUploads).toBe(1);
  });

  it("thread ID検索が2件なら409相当でfail-closedする", async () => {
    const fetch: RedmineFetch = async () => json({
      issues: [issueFixture(123), issueFixture(124)],
      total_count: 2,
      offset: 0,
      limit: 100
    });
    await expect(client(fetch).getThread({ hostResourceKey: "opaque-resource", threadId }))
      .rejects.toMatchObject({ code: "redmine.duplicate_thread_id", upstreamStatus: 409 });
  });

  it("新規issueの初回自己編集権をcontext attachmentから復元する", async () => {
    const issue = issueFixture();
    issue.description = "最初のコメント";
    issue.attachments.push({
      id: 91,
      filename: "feedback-context-v1.json",
      filesize: 512,
      content_type: "application/json",
      content_url: "https://redmine.example.invalid/redmine/attachments/download/91/feedback-context-v1.json",
      author: { id: 7, name: "投稿者" },
      created_on: "2026-08-19T00:00:00Z"
    } as never);
    const context = {
      schemaVersion: "1",
      kind: "feedback-context",
      threadId,
      intentId: createInput.intentId,
      requestHash: "a".repeat(64),
      author: createInput.author,
      initialMessageSignature: "signed-initial-message"
    };
    const ownership = await client(async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/issues.json")) return json({ issues: [issue], total_count: 1, offset: 0, limit: 100 });
      if (path.endsWith("/issues/123.json")) return json({ issue });
      if (path.includes("/attachments/download/91/")) return json(context);
      throw new Error(`unexpected request: ${url}`);
    }).lookupMessageOwnership({ hostResourceKey: "opaque-resource", threadId, messageId: threadId });
    expect(ownership).toMatchObject({
      kind: "initial",
      participantId: createInput.author.participantId,
      intentId: createInput.intentId,
      signature: "signed-initial-message",
      body: "最初のコメント"
    });
  });

  it("threadに属さないattachment IDはmetadata取得前に404にする", async () => {
    let attachmentRequests = 0;
    const fetch: RedmineFetch = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.includes("/attachments/")) attachmentRequests += 1;
      if (parsed.pathname.endsWith("/issues.json")) {
        return json({ issues: [issueFixture()], total_count: 1, offset: 0, limit: 100 });
      }
      if (parsed.pathname.endsWith("/issues/123.json")) return json({ issue: issueFixture() });
      throw new Error(`unexpected request: ${url}`);
    };
    await expect(client(fetch).getAttachment({ hostResourceKey: "opaque-resource", threadId, attachmentId: 999 }))
      .rejects.toMatchObject({ code: "redmine.not_found" });
    expect(attachmentRequests).toBe(0);
  });

  it("attachment URLをsame origin/base pathへ固定する", () => {
    const base = new URL("https://redmine.example.invalid/redmine");
    expect(validateAttachmentContentUrl(base, "/redmine/attachments/download/1/a.png").pathname)
      .toBe("/redmine/attachments/download/1/a.png");
    expect(() => validateAttachmentContentUrl(base, "https://evil.invalid/a.png")).toThrow(/origin外/u);
    expect(() => validateAttachmentContentUrl(base, "/attachments/download/1/a.png")).toThrow(/base path外/u);
    expect(() => validateAttachmentContentUrl(base, "/redmine/%2e%2e/a.png")).toThrow(/不正/u);
  });

  it("Content-Lengthなしのresponseもstream中に上限で中止する", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6_000_000));
        controller.enqueue(new Uint8Array(6_000_000));
      },
      cancel() { cancelled = true; }
    });
    await expect(client(async () => new Response(body, {
      headers: { "content-type": "application/json" }
    })).getCurrentUser()).rejects.toMatchObject({ code: "redmine.payload_too_large" });
    expect(cancelled).toBe(true);
  });

  it("画像attachmentのdeclared MIMEと実体signatureを照合する", async () => {
    const fetch: RedmineFetch = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/issues.json")) {
        return json({ issues: [issueFixture()], total_count: 1, offset: 0, limit: 100 });
      }
      if (parsed.pathname.endsWith("/issues/123.json")) return json({ issue: issueFixture() });
      if (parsed.pathname.endsWith("/attachments/90.json")) {
        return json({ attachment: { content_url: "/redmine/attachments/download/90/evidence.png" } });
      }
      if (parsed.pathname.endsWith("/attachments/download/90/evidence.png")) {
        return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "image/png" } });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    await expect(client(fetch).getAttachment({ hostResourceKey: "opaque-resource", threadId, attachmentId: 90 }))
      .rejects.toMatchObject({ code: "redmine.contract_invalid" });
  });
});
