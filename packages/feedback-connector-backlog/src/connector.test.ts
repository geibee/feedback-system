import { randomUUID } from "node:crypto";
import { calculateFeedbackCommandHash, createFeedbackEnvelopeCodec } from "@geibee/feedback-envelope";
import { describe, expect, it } from "vitest";
import { createFeedbackBacklogConnector } from "./connector.js";
import { BacklogConnectorProblem, type BacklogRequest, type BacklogTransport } from "./types.js";

const participantId = randomUUID();
const scope = { profileId: "backlog-test", installationId: "space-test", workspaceId: "FB", resource: { kind: "record", key: "order-1" } };

describe("Feedback Backlog Connector", () => {
  it("create応答喪失、reply応答喪失、append-only revisionをprovider metadataだけから回収する", async () => {
    const provider = new FakeBacklog();
    const connector = createConnector(provider);
    const threadId = randomUUID();
    const createIntentId = randomUUID();
    provider.loseNextCreateResponse = true;
    const create = await connector.createThread({
      ...scope,
      command: {
        threadId,
        intentId: createIntentId,
        requestHash: hash({ operation: "create" }),
        resource: scope.resource,
        title: "Feedback",
        body: "初期本文"
      }
    });
    expect(create).toMatchObject({ state: "completed", operation: "feedback:create" });

    const candidates = await connector.findThreadCandidatesById({ ...scope, threadId });
    expect(candidates).toHaveLength(1);
    const byResource = await connector.findThreadCandidates({ ...scope });
    expect(byResource.candidates).toHaveLength(1);
    const read = await connector.readCandidate(candidates[0]!);
    expect(read.thread.messages[0]?.body).toBe("初期本文");

    const messageId = randomUUID();
    const replyIntentId = randomUUID();
    provider.loseNextCommentResponse = true;
    const reply = await connector.reply({
      ...scope,
      threadId,
      command: { intentId: replyIntentId, requestHash: hash({ operation: "reply" }), messageId, body: "返信" }
    });
    expect(reply).toMatchObject({ state: "completed", operation: "feedback:reply" });

    const revisionId = randomUUID();
    const revision = await connector.appendRevision({
      ...scope,
      threadId,
      messageId,
      command: {
        intentId: randomUUID(),
        requestHash: hash({ operation: "revision" }),
        revisionId,
        expectedRevisionId: messageId,
        body: "改訂返信"
      }
    });
    expect(revision).toMatchObject({ disposition: "created", message: { body: "改訂返信" } });
    const reread = await connector.readCandidate(candidates[0]!);
    expect(reread.thread.messages.find((message) => message.messageId === messageId)).toMatchObject({
      body: "改訂返信",
      revisions: [{ revisionId, body: "改訂返信" }]
    });
  });

  it("0件をpending、複数threadをrepair_requiredにし、attachmentをunsupportedに閉じる", async () => {
    const provider = new FakeBacklog();
    const connector = createConnector(provider);
    const threadId = randomUUID();
    const requestHash = hash({ operation: "missing" });
    await expect(connector.recoverIntent({ ...scope, threadId, intentId: randomUUID(), requestHash, operation: "feedback:create" }))
      .resolves.toMatchObject({ state: "pending", automaticWriteAllowed: false });

    const firstIntent = randomUUID();
    await connector.createThread({ ...scope, command: { threadId, intentId: firstIntent, requestHash: hash({ value: 1 }), resource: scope.resource, title: "1", body: "1" } });
    await connector.createThread({ ...scope, command: { threadId, intentId: randomUUID(), requestHash: hash({ value: 2 }), resource: scope.resource, title: "2", body: "2" } });
    await expect(connector.recoverIntent({ ...scope, threadId, intentId: firstIntent, requestHash: hash({ value: 1 }), operation: "feedback:create" }))
      .resolves.toMatchObject({ state: "repair_required", retryDirective: "do-not-write" });
    await expect(connector.getAttachment({ ...scope, threadId, attachmentId: randomUUID() }))
      .rejects.toMatchObject({ code: "feedback.unsupported" });
  });
});

function createConnector(transport: BacklogTransport) {
  return createFeedbackBacklogConnector({
    configuration: {
      profileId: scope.profileId,
      installationId: scope.installationId,
      application: "inventory",
      environment: "test",
      participantId,
      workspaceId: scope.workspaceId,
      workspaceDisplayName: "Feedback",
      projectId: 1,
      issueTypeId: 2,
      priorityId: 3,
      customFieldIds: { threadId: 11, intentId: 12, requestHash: 13, resourceKey: 14 },
      pageSize: 100,
      recoveryRetryAfterSeconds: 2,
      maximumMetadataBytes: 32768
    },
    transport,
    envelopeCodec: createFeedbackEnvelopeCodec([{ kid: "test", secret: new Uint8Array(32).fill(7), state: "active" }]),
    now: () => new Date("2026-09-02T00:00:00.000Z")
  });
}

function hash(value: unknown): string { return calculateFeedbackCommandHash(value); }

class FakeBacklog implements BacklogTransport {
  issues: Array<Record<string, any>> = [];
  comments = new Map<number, Array<Record<string, any>>>();
  loseNextCreateResponse = false;
  loseNextCommentResponse = false;
  nextIssueId = 1;
  nextCommentId = 100;

  async request(request: BacklogRequest) {
    const path = new URL(request.path, "https://example.backlog.com");
    if (request.method === "GET" && path.pathname === "/api/v2/projects/1") return ok({ id: 1, projectKey: "FB", name: "Feedback", archived: false });
    if (request.method === "GET" && path.pathname === "/api/v2/issues") {
      const field = [...path.searchParams.keys()].find((name) => name.startsWith("customField_"));
      const id = Number(field?.slice("customField_".length));
      const value = field ? path.searchParams.get(field) : null;
      const offset = Number(path.searchParams.get("offset") ?? 0);
      const count = Number(path.searchParams.get("count") ?? 100);
      const matches = this.issues.filter((issue) => issue.customFields.some((item: any) => item.id === id && item.value === value));
      return ok(matches.slice(offset, offset + count));
    }
    if (request.method === "POST" && path.pathname === "/api/v2/issues") {
      const values = request.body!.values as Record<string, string>;
      const id = this.nextIssueId++;
      const now = "2026-09-02T00:00:00.000Z";
      const issue = {
        id, issueKey: `FB-${id}`, projectId: 1, summary: values.summary, description: values.description,
        customFields: Object.entries(values).flatMap(([name, value]) => name.startsWith("customField_") ? [{ id: Number(name.slice(12)), fieldTypeId: 1, name, value }] : []),
        status: { id: 1, name: "Open" }, created: now, updated: now, createdUser: { name: "Tester" }
      };
      this.issues.push(issue);
      if (this.loseNextCreateResponse) { this.loseNextCreateResponse = false; throw unknownWrite(); }
      return ok(issue);
    }
    const issueMatch = /^\/api\/v2\/issues\/(\d+)$/u.exec(path.pathname);
    if (issueMatch) {
      const issue = this.issues.find((value) => value.id === Number(issueMatch[1]));
      if (!issue) return response(404, null);
      if (request.method === "GET") return ok(issue);
      if (request.method === "PATCH") { issue.description = (request.body!.values as Record<string, string>).description; issue.updated = "2026-09-02T00:01:00.000Z"; return ok(issue); }
    }
    const commentsMatch = /^\/api\/v2\/issues\/(\d+)\/comments$/u.exec(path.pathname);
    if (commentsMatch) {
      const issueId = Number(commentsMatch[1]);
      const values = this.comments.get(issueId) ?? [];
      if (request.method === "GET") return ok(values);
      const id = this.nextCommentId++;
      const comment = { id, content: (request.body!.values as Record<string, string>).content, created: "2026-09-02T00:02:00.000Z", updated: "2026-09-02T00:02:00.000Z", createdUser: { name: "Tester" } };
      values.push(comment); this.comments.set(issueId, values);
      if (this.loseNextCommentResponse) { this.loseNextCommentResponse = false; throw unknownWrite(); }
      return ok(comment);
    }
    return response(404, null);
  }
}

function ok(body: unknown) { return response(200, body); }
function response(status: number, body: unknown) { return { status, headers: {}, body }; }
function unknownWrite() { return new BacklogConnectorProblem({ message: "unknown", status: 504, code: "feedback.provider_timeout", retryable: true, resultUnknown: true }); }
