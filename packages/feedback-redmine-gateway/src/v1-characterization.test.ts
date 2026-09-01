import { buildRedmineMessageNote, parseRedmineMessageNote } from "@geibee/feedback-redmine-core";
import type { RedmineFetch } from "@geibee/feedback-redmine-core/trusted";
import { describe, expect, it, vi } from "vitest";
import {
  attachmentBytes,
  attachmentSha256,
  createIntentId,
  createThreadId,
  editIntentId,
  existingIssue,
  expectedSummary,
  gatewayRequests,
  otherBrowserProfileId,
  ownerBrowserProfileId,
  participantSigningKey,
  profile,
  profileId,
  redmineApiKey,
  replyIntentId,
  replyMessageId,
  threadId
} from "./fixtures/v1-characterization/scenario.js";
import { createFeedbackRedmineGatewayHandler } from "./handler.js";
import { signMessageMarker } from "./participant.js";
import type { GatewayDependencies } from "./profile.js";

type NamedValue = { id: number; name: string };
type CustomField = { id: number; value: string };
type AttachmentState = {
  id: number;
  filename: string;
  filesize: number;
  content_type: string;
  content_url: string;
  author: NamedValue;
  created_on: string;
};
type JournalState = {
  id: number;
  user: NamedValue;
  notes: string;
  created_on: string;
  updated_on: string | null;
  details: unknown[];
};
type IssueState = {
  id: number;
  subject: string;
  description: string;
  status: NamedValue;
  priority: NamedValue;
  author: NamedValue;
  tracker: NamedValue;
  created_on: string;
  updated_on: string;
  custom_fields: CustomField[];
  attachments: AttachmentState[];
  journals: JournalState[];
};
type RedmineCall = {
  method: string;
  url: URL;
  headers: Headers;
  body: string | Uint8Array | null;
};

class RedmineFixtureBackend {
  readonly calls: RedmineCall[] = [];
  readonly issueWrites: Array<Record<string, unknown>> = [];
  readonly messageWrites: Array<Record<string, unknown>> = [];
  readonly #issues = new Map<number, IssueState>();
  readonly #uploads = new Map<string, { filename: string; bytes: Uint8Array }>();
  #nextIssueId = 124;
  #nextJournalId = 901;
  #nextAttachmentId = 601;

  constructor() {
    this.#issues.set(existingIssue.id, structuredClone(existingIssue) as IssueState);
  }

  readonly fetch = vi.fn<RedmineFetch>(async (input, init) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const body = readBody(init.body);
    this.calls.push({ method, url, headers: new Headers(init.headers), body });

    if (method === "GET" && url.pathname === "/redmine/issues.json") {
      const issues = this.#filteredIssues(url.searchParams);
      return jsonResponse({ issues, total_count: issues.length, offset: 0, limit: 100 });
    }
    if (method === "POST" && url.pathname === "/redmine/uploads.json") {
      if (!(body instanceof Uint8Array)) throw new Error("upload bodyがbytesではありません");
      const token = `upload-token-${this.#uploads.size + 1}`;
      this.#uploads.set(token, {
        filename: url.searchParams.get("filename") ?? "attachment",
        bytes: Uint8Array.from(body)
      });
      return jsonResponse({ upload: { token } }, 201);
    }
    if (method === "POST" && url.pathname === "/redmine/issues.json") {
      const envelope = parseJsonBody(body);
      const issueWrite = objectValue(envelope.issue, "issue write");
      this.issueWrites.push(issueWrite);
      const issue = this.#createIssue(issueWrite);
      this.#issues.set(issue.id, issue);
      return jsonResponse({ issue: { id: issue.id } }, 201);
    }
    const issueMatch = /^\/redmine\/issues\/(\d+)\.json$/u.exec(url.pathname);
    if (issueMatch && method === "GET") {
      const issue = this.#issues.get(Number(issueMatch[1]));
      return issue ? jsonResponse({ issue }) : jsonResponse({ error: "not found" }, 404);
    }
    if (issueMatch && method === "PUT") {
      const issue = this.#issues.get(Number(issueMatch[1]));
      if (!issue) return jsonResponse({ error: "not found" }, 404);
      const envelope = parseJsonBody(body);
      const issueWrite = objectValue(envelope.issue, "message write");
      this.messageWrites.push(issueWrite);
      if (typeof issueWrite.description === "string") issue.description = issueWrite.description;
      if (typeof issueWrite.notes === "string") {
        issue.journals.push({
          id: this.#nextJournalId++,
          user: { id: 7, name: "Feedback Integration" },
          notes: issueWrite.notes,
          created_on: "2026-08-31T02:00:00Z",
          updated_on: null,
          details: []
        });
      }
      issue.updated_on = "2026-08-31T02:00:00Z";
      return new Response(null, { status: 204 });
    }
    const attachmentMatch = /^\/redmine\/attachments\/(\d+)\.json$/u.exec(url.pathname);
    if (attachmentMatch && method === "GET") {
      const attachment = this.#attachment(Number(attachmentMatch[1]));
      return attachment ? jsonResponse({ attachment }) : jsonResponse({ error: "not found" }, 404);
    }
    if (method === "GET" && url.pathname === "/redmine/attachments/download/501/evidence.png") {
      return new Response(Uint8Array.from(attachmentBytes).buffer, {
        headers: { "Content-Type": "image/png", "Content-Length": String(attachmentBytes.byteLength) }
      });
    }
    const uploadedAttachment = /^\/redmine\/attachments\/download\/(\d+)\/(.+)$/u.exec(url.pathname);
    if (uploadedAttachment && method === "GET") {
      const attachment = this.#attachment(Number(uploadedAttachment[1]));
      const upload = [...this.#uploads.values()].find((candidate) => candidate.filename === attachment?.filename);
      if (attachment && upload) {
        return new Response(Uint8Array.from(upload.bytes).buffer, {
          headers: {
            "Content-Type": attachment.content_type,
            "Content-Length": String(upload.bytes.byteLength)
          }
        });
      }
    }
    throw new Error(`未定義のRedmine fixture requestです: ${method} ${url}`);
  });

  issue(id = 123): IssueState {
    const issue = this.#issues.get(id);
    if (!issue) throw new Error(`fixture issue ${id}がありません`);
    return issue;
  }

  addJournal(notes: string): void {
    this.issue().journals.push({
      id: this.#nextJournalId++,
      user: { id: 7, name: "Feedback Integration" },
      notes,
      created_on: "2026-08-31T01:30:00Z",
      updated_on: null,
      details: []
    });
  }

  #filteredIssues(query: URLSearchParams): IssueState[] {
    expect(query.get("project_id")).toBe("12");
    expect(query.get("tracker_id")).toBe("4");
    expect(query.get("cf_23")).toBe("inventory");
    expect(query.get("cf_24")).toBe("production");
    expect(query.get("cf_25")).toBe("production-review");
    let issues = [...this.#issues.values()];
    for (const [fieldId, parameter] of [[21, "cf_21"], [26, "cf_26"], [27, "cf_27"]] as const) {
      const expected = query.get(parameter);
      if (expected !== null) {
        issues = issues.filter((issue) => issue.custom_fields.some((field) => field.id === fieldId && field.value === expected));
      }
    }
    return structuredClone(issues);
  }

  #createIssue(write: Record<string, unknown>): IssueState {
    const id = this.#nextIssueId++;
    const uploads = Array.isArray(write.uploads) ? write.uploads.map((value) => objectValue(value, "upload")) : [];
    const attachments = uploads.map((upload): AttachmentState => {
      const token = String(upload.token);
      const stored = this.#uploads.get(token);
      if (!stored) throw new Error(`upload token ${token}がありません`);
      const attachmentId = this.#nextAttachmentId++;
      return {
        id: attachmentId,
        filename: String(upload.filename),
        filesize: stored.bytes.byteLength,
        content_type: String(upload.content_type),
        content_url: `https://redmine.example.invalid/redmine/attachments/download/${attachmentId}/${stored.filename}`,
        author: { id: 7, name: "Feedback Integration" },
        created_on: "2026-08-31T01:00:00Z"
      };
    });
    return {
      id,
      subject: String(write.subject),
      description: String(write.description),
      status: { id: 1, name: "新規" },
      priority: { id: Number(write.priority_id), name: "通常" },
      author: { id: 7, name: "Feedback Integration" },
      tracker: { id: Number(write.tracker_id), name: "Feedback" },
      created_on: "2026-08-31T01:00:00Z",
      updated_on: "2026-08-31T01:00:00Z",
      custom_fields: structuredClone(write.custom_fields) as CustomField[],
      attachments,
      journals: []
    };
  }

  #attachment(id: number): AttachmentState | null {
    for (const issue of this.#issues.values()) {
      const attachment = issue.attachments.find((candidate) => candidate.id === id);
      if (attachment) return attachment;
    }
    return null;
  }
}

describe("Redmine gateway v1 characterization", () => {
  it("profile: credentialなしで公開profileへ到達し、存在しないprofileは境界で404にする", async () => {
    const fixture = createHarness();
    const response = await fixture.handler(gatewayRequest(gatewayRequests.profile));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      profile: { ...profile.clientProfile, showRedmineLink: false },
      capabilities: { canRead: true, canCreate: true, canReply: true, canEditOwn: true, stateReadOnly: true }
    });
    expect(fixture.backend.fetch).not.toHaveBeenCalled();

    const missing = await fixture.handler(gatewayRequest({
      ...gatewayRequests.profile,
      path: "/internal/feedback-redmine/v1/profiles/unknown-profile"
    }));
    expect(missing.status).toBe(404);
    expect(fixture.loadSecret).not.toHaveBeenCalled();
  });

  it("一覧: credentialなしのresource queryをprofile固定のRedmine検索へ写像する", async () => {
    const fixture = createHarness();
    const response = await fixture.handler(gatewayRequest(gatewayRequests.list));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ threads: [expectedSummary], totalCount: 1, nextCursor: null });
    const [call] = fixture.backend.calls;
    expectRedmineRead(call, "/redmine/issues.json");
    expect(call!.url.searchParams.get("cf_26")).toBe("orders.detail");
    expect(call!.url.searchParams.get("cf_27")).toBe("order-1");
    expect(call!.url.searchParams.get("sort")).toBe("updated_on:desc");
  });

  it("詳細: credentialなしでresource所属確認後にjournal・attachmentを返す", async () => {
    const fixture = createHarness();
    const response = await fixture.handler(gatewayRequest(gatewayRequests.detail));

    expect(response.status).toBe(200);
    const result = await response.json() as { thread: Record<string, unknown> };
    expect(result.thread).toMatchObject({
      ...expectedSummary,
      description: "初回投稿",
      tracker: { id: 4, name: "Feedback" },
      timeline: [],
      diagnosticCount: 0,
      redmineUrl: null,
      messages: [{ id: threadId, kind: "initial", body: "初回投稿", version: 1, canEdit: false }],
      attachments: [{ id: 501, filename: "evidence.png", contentType: "image/png", primaryEvidence: false }]
    });
    expect(fixture.backend.calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "GET /redmine/issues.json",
      "GET /redmine/issues.json",
      "GET /redmine/issues/123.json"
    ]);
  });

  it("投稿: host sessionなしで発行したbrowser participant credentialによりRedmine issueを作る", async () => {
    const fixture = createHarness();
    const participant = await issueParticipant(fixture.handler, ownerBrowserProfileId);
    const form = new FormData();
    form.append("request", new Blob([JSON.stringify(gatewayRequests.create.body)], { type: "application/json" }));
    const response = await fixture.handler(gatewayRequest(gatewayRequests.create, {
      headers: { "X-Feedback-Participant-Credential": participant.credential },
      body: form
    }));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      thread: {
        threadId: createThreadId,
        initialComment: gatewayRequests.create.body.comment,
        perspectiveCode: "ux",
        redmineUrl: null
      }
    });
    expect(fixture.backend.issueWrites).toHaveLength(1);
    const write = fixture.backend.issueWrites[0]!;
    expect(write).toMatchObject({
      project_id: 12,
      tracker_id: 4,
      subject: "[ux] 新しいフィードバック",
      description: "新しいフィードバック\n\n---\nアプリでこのフィードバックを開く\n" +
        `https://app.example/orders/1?feedbackThread=${createThreadId}`,
      is_private: true,
      priority_id: 2,
      uploads: [{ filename: "feedback-context-v1.json", content_type: "application/json" }]
    });
    const fields = new Map((write.custom_fields as CustomField[]).map((field) => [field.id, field.value]));
    expect(fields.get(21)).toBe(createThreadId);
    expect(fields.get(22)).toMatch(/^[a-f0-9]{64}$/u);
    expect(fields.get(23)).toBe("inventory");
    expect(fields.get(24)).toBe("production");
    expect(fields.get(25)).toBe("production-review");
    expect(fields.get(26)).toBe("orders.detail");
    expect(fields.get(27)).toBe("order-1");
    expect(fields.get(30)).toBe(participant.participantId);
    expect(fields.size).toBe(11);
    const contextUploadCall = fixture.backend.calls.find((call) =>
      call.method === "POST" && call.url.pathname === "/redmine/uploads.json" &&
      call.url.searchParams.get("filename") === "feedback-context-v1.json"
    );
    expect(contextUploadCall?.headers.get("content-type")).toBe("application/octet-stream");
    expect(contextUploadCall?.headers.get("x-redmine-api-key")).toBe(redmineApiKey);
    expect(parseBytesJson(contextUploadCall?.body)).toMatchObject({
      schemaVersion: "1",
      kind: "feedback-context",
      threadId: createThreadId,
      intentId: createIntentId,
      requestHash: fields.get(22),
      hostResourceKey: "order-1",
      author: { source: "participant-credential", participantId: participant.participantId, displayName: "利用者A" }
    });
    const issueCall = fixture.backend.calls.find((call) => call.method === "POST" && call.url.pathname === "/redmine/issues.json");
    expectRedmineWrite(issueCall, "/redmine/issues.json");
  });

  it("返信: participant credentialを必須にし、そのparticipantを返信所有者としてmarkerへ保存する", async () => {
    const fixture = createHarness();
    const missing = await fixture.handler(gatewayRequest(gatewayRequests.reply, {
      body: JSON.stringify(gatewayRequests.reply.body)
    }));
    expect(missing.status).toBe(403);
    expect(fixture.backend.fetch).not.toHaveBeenCalled();

    const participant = await issueParticipant(fixture.handler, ownerBrowserProfileId);
    const response = await fixture.handler(gatewayRequest(gatewayRequests.reply, {
      headers: { "X-Feedback-Participant-Credential": participant.credential },
      body: JSON.stringify(gatewayRequests.reply.body)
    }));

    expect(response.status).toBe(201);
    const result = await response.json() as { thread: { messages: Array<Record<string, unknown>> } };
    expect(result.thread.messages).toContainEqual(expect.objectContaining({
      id: replyMessageId,
      kind: "reply",
      body: gatewayRequests.reply.body.body,
      author: { kind: "participant", participantId: participant.participantId, displayName: "利用者A" },
      version: 1,
      canEdit: true
    }));
    const write = fixture.backend.messageWrites[0]!;
    expect(Object.keys(write)).toEqual(["notes"]);
    expect(parseRedmineMessageNote(String(write.notes))).toMatchObject({
      body: gatewayRequests.reply.body.body,
      metadata: {
        kind: "reply",
        messageId: replyMessageId,
        participantId: participant.participantId,
        participantName: "利用者A",
        version: 1,
        intentId: replyIntentId
      }
    });
    expectRedmineWrite(
      fixture.backend.calls.find((call) => call.method === "PUT"),
      "/redmine/issues/123.json"
    );
  });

  it("自己編集: 有効な別participantを拒否し、所有者だけが追記型edit journalを作る", async () => {
    const fixture = createHarness();
    const owner = await issueParticipant(fixture.handler, ownerBrowserProfileId);
    const other = await issueParticipant(fixture.handler, otherBrowserProfileId);
    const replySignature = await signMessageMarker({
      signingKey: participantSigningKey,
      profileId,
      threadId,
      messageId: replyMessageId,
      participantId: owner.participantId,
      kind: "reply",
      version: 1,
      intentId: replyIntentId,
      body: gatewayRequests.reply.body.body
    });
    fixture.backend.addJournal(buildRedmineMessageNote(gatewayRequests.reply.body.body, {
      kind: "reply",
      messageId: replyMessageId,
      participantId: owner.participantId,
      participantName: "利用者A",
      version: 1,
      intentId: replyIntentId,
      signature: replySignature
    }));

    const denied = await fixture.handler(gatewayRequest(gatewayRequests.edit, {
      headers: { "X-Feedback-Participant-Credential": other.credential },
      body: JSON.stringify(gatewayRequests.edit.body)
    }));
    expect(denied.status).toBe(403);
    expect(fixture.backend.messageWrites).toHaveLength(0);

    const response = await fixture.handler(gatewayRequest(gatewayRequests.edit, {
      headers: { "X-Feedback-Participant-Credential": owner.credential },
      body: JSON.stringify(gatewayRequests.edit.body)
    }));
    expect(response.status).toBe(200);
    const result = await response.json() as { thread: { messages: Array<Record<string, unknown>> } };
    expect(result.thread.messages).toContainEqual(expect.objectContaining({
      id: replyMessageId,
      body: gatewayRequests.edit.body.body,
      version: 2,
      canEdit: true
    }));
    expect(parseRedmineMessageNote(String(fixture.backend.messageWrites[0]!.notes))).toMatchObject({
      body: gatewayRequests.edit.body.body,
      metadata: {
        kind: "edit",
        messageId: replyMessageId,
        participantId: owner.participantId,
        version: 2,
        intentId: editIntentId
      }
    });
  });

  it("添付取得: credentialなしでthread所属を確認し、gatewayから検証済みbytesを返す", async () => {
    const fixture = createHarness();
    const response = await fixture.handler(gatewayRequest(gatewayRequests.attachment));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe("attachment; filename=\"evidence.png\"; filename*=UTF-8''evidence.png");
    expect(response.headers.get("x-feedback-content-sha256")).toBe(attachmentSha256);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(attachmentBytes);
    expect(fixture.backend.calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "GET /redmine/issues.json",
      "GET /redmine/issues.json",
      "GET /redmine/issues/123.json",
      "GET /redmine/attachments/501.json",
      "GET /redmine/attachments/download/501/evidence.png"
    ]);
  });
});

function createHarness(): {
  backend: RedmineFixtureBackend;
  handler: ReturnType<typeof createFeedbackRedmineGatewayHandler>;
  loadSecret: ReturnType<typeof vi.fn<GatewayDependencies["loadSecret"]>>;
} {
  const backend = new RedmineFixtureBackend();
  const loadSecret = vi.fn<GatewayDependencies["loadSecret"]>().mockResolvedValue(redmineApiKey);
  const dependencies: GatewayDependencies = {
    participantSigningKey,
    loadProfile: vi.fn(async (requestedProfileId) => requestedProfileId === profileId ? profile : null),
    loadSecret,
    fetch: backend.fetch
  };
  return { backend, handler: createFeedbackRedmineGatewayHandler(dependencies), loadSecret };
}

async function issueParticipant(
  handler: ReturnType<typeof createFeedbackRedmineGatewayHandler>,
  browserProfileId: string
): Promise<{ participantId: string; credential: string }> {
  const response = await handler(gatewayRequest({
    method: "POST",
    path: `/internal/feedback-redmine/v1/profiles/${profileId}/participants`,
    headers: { "Content-Type": "application/json" }
  }, { body: JSON.stringify({ browserProfileId }) }));
  expect(response.status).toBe(201);
  return response.json() as Promise<{ participantId: string; credential: string }>;
}

function gatewayRequest(
  fixture: { method: string; path: string; headers: Readonly<Record<string, string>> },
  override: { headers?: Record<string, string>; body?: BodyInit } = {}
): Request {
  return new Request(`https://app.example${fixture.path}`, {
    method: fixture.method,
    headers: {
      Origin: "https://app.example",
      "Sec-Fetch-Site": "same-origin",
      ...fixture.headers,
      ...override.headers
    },
    body: override.body
  });
}

function expectRedmineRead(call: RedmineCall | undefined, pathname: string): void {
  expect(call).toBeDefined();
  expect(call!.method).toBe("GET");
  expect(call!.url.pathname).toBe(pathname);
  expect(call!.headers.get("accept")).toBe("application/json");
  expect(call!.headers.get("x-redmine-api-key")).toBe(redmineApiKey);
  expect(call!.headers.has("content-type")).toBe(false);
  expect(call!.body).toBeNull();
}

function expectRedmineWrite(call: RedmineCall | undefined, pathname: string): void {
  expect(call).toBeDefined();
  expect(call!.url.pathname).toBe(pathname);
  expect(call!.headers.get("accept")).toBe("application/json");
  expect(call!.headers.get("x-redmine-api-key")).toBe(redmineApiKey);
  expect(call!.headers.get("content-type")).toBe("application/json");
  expect(typeof call!.body).toBe("string");
}

function readBody(body: BodyInit | null | undefined): string | Uint8Array | null {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  }
  throw new Error("fixtureで未対応のRedmine request bodyです");
}

function parseJsonBody(body: string | Uint8Array | null): Record<string, unknown> {
  if (typeof body !== "string") throw new Error("Redmine JSON bodyがstringではありません");
  return objectValue(JSON.parse(body), "Redmine JSON body");
}

function parseBytesJson(body: string | Uint8Array | null | undefined): Record<string, unknown> {
  if (!(body instanceof Uint8Array)) throw new Error("Redmine upload bodyがbytesではありません");
  return objectValue(JSON.parse(new TextDecoder().decode(body)), "Redmine upload JSON body");
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name}がobjectではありません`);
  return value as Record<string, unknown>;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}
