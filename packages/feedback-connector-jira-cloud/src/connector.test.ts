import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FeedbackRepositoryScope } from "@geibee/feedback-connector-sdk";
import { createFeedbackEnvelopeCodec, calculateFeedbackCommandHash } from "@geibee/feedback-envelope";
import { createFeedbackJiraCloudConnector } from "./connector.js";
import { JiraCloudConnectorProblem, type JiraCloudRequest, type JiraCloudResponse, type JiraCloudTransport } from "./types.js";

const threadId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5001";
const createIntentId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5002";
const messageId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5011";
const replyIntentId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5012";
const attachmentId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5021";
const attachmentIntentId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5022";
const requestHash = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const contentHash123 = `sha256:${createHash("sha256").update(Uint8Array.from([1, 2, 3])).digest("hex")}`;
const participantId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5099";
const createdAt = "2026-08-31T12:00:00.000Z";
const scope: FeedbackRepositoryScope = {
  profileId: "jira-cloud-test",
  installationId: "site-placeholder",
  workspaceId: "TEST",
  resource: { kind: "record", key: "synthetic-001" }
};

class FakeTransport implements JiraCloudTransport {
  readonly requests: JiraCloudRequest[] = [];
  constructor(readonly respond: (request: JiraCloudRequest, index: number) => JiraCloudResponse | Promise<JiraCloudResponse>) {}
  async request(request: JiraCloudRequest): Promise<JiraCloudResponse> {
    this.requests.push(request);
    return this.respond(request, this.requests.length - 1);
  }
}

const codec = createFeedbackEnvelopeCodec([{
  kid: "jira-test",
  secret: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
  state: "active"
}]);

function connector(transport: JiraCloudTransport) {
  return createFeedbackJiraCloudConnector({
    configuration: {
      profileId: scope.profileId,
      installationId: scope.installationId,
      application: "inventory",
      environment: "test",
      participantId,
      issueTypeId: "10000",
      maximumAttachmentBytes: 1024,
      attachmentContentTypes: ["text/plain", "image/png"],
      pageSize: 1,
      recoveryRetryAfterSeconds: 2
    },
    transport,
    envelopeCodec: codec,
    now: () => new Date(createdAt)
  });
}

async function boundProperty(intentId = createIntentId) {
  const envelope = await codec.signEnvelope({
    schemaVersion: "2",
    threadId,
    intentId,
    requestHash,
    providerBinding: { profileId: scope.profileId, installationId: scope.installationId, objectId: "10001" },
    scope: { workspace: scope.workspaceId, resource: scope.resource, application: "inventory", environment: "test" },
    createdBy: { participantId },
    createdAt
  });
  return {
    schemaVersion: "2",
    threadId,
    intentId,
    requestHash,
    scope: { workspaceId: scope.workspaceId, resource: scope.resource },
    state: "bound",
    envelope
  };
}

function issue(properties?: Record<string, unknown>) {
  return {
    id: "10001",
    key: "TEST-1",
    fields: {
      summary: "Synthetic feedback",
      description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] },
      status: { statusCategory: { key: "new" } },
      created: createdAt,
      updated: createdAt
    },
    ...(properties ? { properties } : {})
  };
}

function ok(body: unknown, status = 200, headers: Record<string, string> = {}): JiraCloudResponse {
  return { status, headers, body };
}

function propertyPath(key: string) {
  return `/rest/api/3/issue/10001/properties/${encodeURIComponent(key)}`;
}

function adf(body: string) {
  return { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: body }] }] };
}

function candidateReadTransport(input: {
  property: unknown;
  comments?: unknown[];
  attachmentMarkers?: Readonly<Record<string, unknown>>;
}) {
  const attachmentMarkers = input.attachmentMarkers ?? {};
  return new FakeTransport((request) => {
    if (request.path === "/rest/api/3/search/jql") {
      return ok({ issues: [issue({ "com.geibee.feedback.recovery.v2": input.property })], isLast: true });
    }
    if (request.path === propertyPath("com.geibee.feedback.recovery.v2")) return ok({ value: input.property });
    if (request.path.startsWith("/rest/api/3/issue/10001?")) return ok(issue());
    if (request.path.startsWith("/rest/api/3/issue/10001/comment?")) {
      const comments = input.comments ?? [];
      const startAt = Number(/[?&]startAt=([0-9]+)/u.exec(request.path)?.[1] ?? 0);
      return ok({ comments: comments.slice(startAt, startAt + 1), startAt, maxResults: 1, total: comments.length });
    }
    if (request.path === "/rest/api/3/issue/10001/properties") {
      return ok({ keys: [
        { key: "com.geibee.feedback.recovery.v2" },
        ...Object.keys(attachmentMarkers).map((key) => ({ key }))
      ] });
    }
    for (const [key, value] of Object.entries(attachmentMarkers)) {
      if (request.path === propertyPath(key)) return ok({ value });
    }
    throw new Error(`unexpected request: ${request.method} ${request.path}`);
  });
}

async function readOnlyCandidate(repository: ReturnType<typeof connector>) {
  const candidates = await repository.findThreadCandidatesById({ ...scope, threadId });
  return repository.readCandidate(candidates[0]!);
}

describe("Jira Cloud Connector managed acceptance fake", () => {
  it("Jira component discoveryをsigned grant互換のrecord resourceへ正規化する", async () => {
    const transport = new FakeTransport((request) => {
      if (request.path.startsWith("/rest/api/3/project/TEST/components?")) {
        return ok({
          values: [{ id: "20001", name: "Inventory" }],
          total: 1
        });
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`);
    });
    const page = await connector(transport).listResources({ profileId: scope.profileId, workspaceId: scope.workspaceId });
    expect(page).toEqual({
      items: [{ resource: { kind: "record", key: "20001" }, displayName: "Inventory" }],
      nextCursor: null
    });
  });

  it("cursorをquery fingerprintへ束縛し、JQLへ到達するworkspace injectionを拒否する", async () => {
    const transport = new FakeTransport((request) => {
      if (request.path.startsWith("/rest/api/3/project/TEST/components?")) {
        return ok({ values: [{ id: "20001", name: "Inventory" }], total: 2 });
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`);
    });
    const repository = connector(transport);
    const first = await repository.listResources({ profileId: scope.profileId, workspaceId: scope.workspaceId });
    expect(first.nextCursor).toBeTypeOf("string");
    await expect(repository.listResources({
      profileId: scope.profileId,
      workspaceId: scope.workspaceId,
      query: "changed-query",
      cursor: first.nextCursor!
    })).rejects.toMatchObject({ code: "feedback.invalid_request" });
    await expect(repository.findThreadCandidates({
      ...scope,
      workspaceId: "TEST) OR project = SECRET"
    })).rejects.toMatchObject({ code: "feedback.invalid_request" });
    expect(transport.requests).toHaveLength(1);
  });

  it("最初のissue POSTへtripletを同時保存し、bound propertyを直接再読込する", async () => {
    let stored: unknown;
    const transport = new FakeTransport((request) => {
      if (request.method === "POST" && request.path.startsWith("/rest/api/3/issue?")) return ok({ id: "10001", key: "TEST-1" }, 201);
      if (request.method === "PUT" && request.path === propertyPath("com.geibee.feedback.recovery.v2")) {
        stored = request.body?.kind === "json" ? request.body.value : undefined;
        return ok(null, 204);
      }
      if (request.method === "GET" && request.path === propertyPath("com.geibee.feedback.recovery.v2")) return ok({ key: "com.geibee.feedback.recovery.v2", value: stored });
      if (request.method === "GET" && request.path.startsWith("/rest/api/3/issue/10001?")) return ok(issue());
      if (request.method === "GET" && request.path.startsWith("/rest/api/3/issue/10001/comment?")) return ok({ comments: [], startAt: 0, maxResults: 1, total: 0 });
      if (request.method === "GET" && request.path === "/rest/api/3/issue/10001/properties") return ok({ keys: [{ key: "com.geibee.feedback.recovery.v2" }] });
      throw new Error(`unexpected request: ${request.method} ${request.path}`);
    });

    const result = await connector(transport).createThread({
      ...scope,
      command: { threadId, intentId: createIntentId, requestHash, resource: scope.resource, title: "Synthetic feedback", body: "hello" }
    });
    expect("disposition" in result && result.disposition).toBe("created");
    const first = transport.requests[0]!;
    expect(first.method).toBe("POST");
    const firstBody = first.body?.kind === "json" ? first.body.value as { properties: { value: Record<string, unknown> }[] } : undefined;
    expect(firstBody?.properties[0]?.value).toMatchObject({ threadId, intentId: createIntentId, requestHash, state: "recovery-seed" });
    expect(transport.requests.filter((request) => request.method === "POST" && request.path.startsWith("/rest/api/3/issue?"))).toHaveLength(1);
    expect(stored).toMatchObject({ threadId, intentId: createIntentId, requestHash, state: "bound" });
    expect(transport.requests.some((request) => request.method === "GET" && request.path === propertyPath("com.geibee.feedback.recovery.v2"))).toBe(true);
  });

  it("JQL projectionは未信頼候補として返し、read時に正本propertyとraw markerを再取得する", async () => {
    const property = await boundProperty();
    const marker = await codec.signMessageMarker({
      schemaVersion: "2",
      threadId,
      eventId: messageId,
      eventKind: "reply",
      messageId,
      intentId: replyIntentId,
      requestHash,
      participantId,
      bodyHash: calculateFeedbackCommandHash({ body: "reply" }),
      providerBinding: { profileId: scope.profileId, installationId: scope.installationId, objectId: "10001" },
      createdAt
    });
    const transport = new FakeTransport((request) => {
      if (request.path === "/rest/api/3/search/jql") return ok({ issues: [issue({ "com.geibee.feedback.recovery.v2": property })], isLast: true });
      if (request.path === propertyPath("com.geibee.feedback.recovery.v2")) return ok({ value: property });
      if (request.path.startsWith("/rest/api/3/issue/10001?")) return ok(issue());
      if (request.path.startsWith("/rest/api/3/issue/10001/comment?")) return ok({
        comments: [{ id: "20001", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "reply" }] }] }, created: createdAt, properties: [{ key: "com.geibee.feedback.message.v2", value: marker }] }],
        startAt: 0,
        maxResults: 1,
        total: 1
      });
      if (request.path === "/rest/api/3/issue/10001/properties") return ok({ keys: [{ key: "com.geibee.feedback.recovery.v2" }] });
      throw new Error(`unexpected request: ${request.method} ${request.path}`);
    });
    const repository = connector(transport);
    const candidates = await repository.findThreadCandidatesById({ ...scope, threadId });
    expect(candidates).toHaveLength(1);
    const record = await repository.readCandidate(candidates[0]!);
    expect(record.envelope).toEqual(property.envelope);
    expect(record.legacyMetadata).toMatchObject({ provider: "jira-cloud", commentMarkers: [{ providerCommentId: "20001", marker }] });
    expect(record.thread.messages.map((message) => message.messageId)).toEqual([threadId, messageId]);
  });

  it("malformed projectionを候補欠落へ変換せずintegrity errorでfail-closedにする", async () => {
    const malformed = {
      schemaVersion: "2",
      threadId,
      intentId: createIntentId,
      requestHash,
      scope: { workspaceId: scope.workspaceId, resource: scope.resource },
      state: "bound",
      envelope: {}
    };
    const transport = new FakeTransport((request) => request.path === "/rest/api/3/search/jql"
      ? ok({ issues: [issue({ "com.geibee.feedback.recovery.v2": malformed })], isLast: true })
      : (() => { throw new Error(`unexpected request: ${request.path}`); })());
    await expect(connector(transport).findThreadCandidatesById({ ...scope, threadId }))
      .rejects.toMatchObject({ code: "feedback.integrity_error" });
  });

  it("署名不正のbound projectionでもunsigned profileへfallbackせず候補として検証境界へ渡す", async () => {
    const invalidSigned = {
      schemaVersion: "2",
      threadId,
      intentId: createIntentId,
      requestHash,
      scope: { workspaceId: scope.workspaceId, resource: { kind: "record", key: "tampered-scope" } },
      state: "bound",
      envelope: {
        providerBinding: { profileId: "signed-profile", installationId: scope.installationId, objectId: "10001" },
        signature: { alg: "HS256", kid: "unknown", value: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }
      }
    };
    const transport = new FakeTransport((request) => request.path === "/rest/api/3/search/jql"
      ? ok({ issues: [issue({ "com.geibee.feedback.recovery.v2": invalidSigned })], isLast: true })
      : (() => { throw new Error(`unexpected request: ${request.path}`); })());
    const candidates = await connector(transport).findThreadCandidates({ ...scope });
    expect(candidates.candidates).toHaveLength(1);
    expect(candidates.candidates[0]?.projection).toMatchObject({
      profileId: "signed-profile",
      resource: { kind: "record", key: "tampered-scope" }
    });
  });

  it("create response喪失後はPOSTを再発行せずJQL seedをbound Envelopeへ補修する", async () => {
    const seed = {
      schemaVersion: "2",
      threadId,
      intentId: createIntentId,
      requestHash,
      scope: { workspaceId: scope.workspaceId, resource: scope.resource },
      state: "recovery-seed"
    };
    let stored: unknown = seed;
    const transport = new FakeTransport((request) => {
      if (request.method === "POST" && request.path.startsWith("/rest/api/3/issue?")) {
        throw new JiraCloudConnectorProblem({ message: "timeout", status: 504, code: "feedback.provider_timeout", retryable: true, resultUnknown: true });
      }
      if (request.path === "/rest/api/3/search/jql") return ok({ issues: [issue({ "com.geibee.feedback.recovery.v2": seed })], isLast: true });
      if (request.method === "GET" && request.path === propertyPath("com.geibee.feedback.recovery.v2")) return ok({ value: stored });
      if (request.method === "PUT" && request.path === propertyPath("com.geibee.feedback.recovery.v2")) {
        stored = request.body?.kind === "json" ? request.body.value : null;
        return ok(null, 204);
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`);
    });
    const result = await connector(transport).createThread({
      ...scope,
      command: { threadId, intentId: createIntentId, requestHash, resource: scope.resource, title: "Synthetic feedback", body: "hello" }
    });
    expect(result).toEqual({ intentId: createIntentId, state: "completed", operation: "feedback:create", stableResultId: threadId });
    expect(transport.requests.filter((request) => request.method === "POST" && request.path.startsWith("/rest/api/3/issue?"))).toHaveLength(1);
    expect(stored).toMatchObject({ threadId, intentId: createIntentId, requestHash, state: "bound" });
  });

  it("create timeout後のJQL missをpendingにし自動再createを禁止する", async () => {
    const transport = new FakeTransport((request) => {
      if (request.method === "POST" && request.path.startsWith("/rest/api/3/issue?")) {
        throw new JiraCloudConnectorProblem({ message: "timeout", status: 504, code: "feedback.provider_timeout", retryable: true, resultUnknown: true });
      }
      if (request.path === "/rest/api/3/search/jql") return ok({ issues: [], isLast: true });
      throw new Error(`unexpected request: ${request.method} ${request.path}`);
    });
    const result = await connector(transport).createThread({
      ...scope,
      command: { threadId, intentId: createIntentId, requestHash, resource: scope.resource, title: "Synthetic feedback", body: "hello" }
    });
    expect(result).toEqual({
      intentId: createIntentId,
      state: "pending",
      operation: "feedback:create",
      retryAfterSeconds: 2,
      automaticWriteAllowed: false
    });
    expect(transport.requests.filter((request) => request.method === "POST" && request.path.startsWith("/rest/api/3/issue?"))).toHaveLength(1);
  });

  it("reply本文と署名markerを単一POSTに入れ、propertyを直接再読込する", async () => {
    const property = await boundProperty();
    let postedMarker: unknown;
    const transport = new FakeTransport((request) => {
      if (request.path === "/rest/api/3/search/jql") return ok({ issues: [issue({ "com.geibee.feedback.recovery.v2": property })], isLast: true });
      if (request.path === propertyPath("com.geibee.feedback.recovery.v2")) return ok({ value: property });
      if (request.path.startsWith("/rest/api/3/issue/10001?")) return ok(issue());
      if (request.method === "POST" && request.path === "/rest/api/3/issue/10001/comment") {
        const body = request.body?.kind === "json" ? request.body.value as { body: unknown; properties: { value: unknown }[] } : undefined;
        postedMarker = body?.properties[0]?.value;
        return ok({ id: "20001", body: body?.body, created: createdAt, properties: body?.properties }, 201);
      }
      if (request.path === `/rest/api/3/comment/20001/properties/${encodeURIComponent("com.geibee.feedback.message.v2")}`) return ok({ value: postedMarker });
      throw new Error(`unexpected request: ${request.method} ${request.path}`);
    });
    const result = await connector(transport).reply({
      ...scope,
      threadId,
      command: { intentId: replyIntentId, requestHash, messageId, body: "reply" }
    });
    expect("disposition" in result && result.disposition).toBe("created");
    const writes = transport.requests.filter((request) => request.method === "POST" && request.path.endsWith("/comment"));
    expect(writes).toHaveLength(1);
    expect(transport.requests.some((request) => request.path.startsWith("/rest/api/3/issue/10001/comment/20001/properties/"))).toBe(false);
    expect(postedMarker).toMatchObject({ threadId, messageId, intentId: replyIntentId, requestHash, eventKind: "reply" });
  });

  it("署名markerのbodyHashと実comment本文が違う場合はfail-closedにする", async () => {
    const property = await boundProperty();
    const marker = await codec.signMessageMarker({
      schemaVersion: "2",
      threadId,
      eventId: messageId,
      eventKind: "reply",
      messageId,
      intentId: replyIntentId,
      requestHash,
      participantId,
      bodyHash: calculateFeedbackCommandHash({ body: "original" }),
      providerBinding: { profileId: scope.profileId, installationId: scope.installationId, objectId: "10001" },
      createdAt
    });
    const transport = candidateReadTransport({
      property,
      comments: [{ id: "20001", body: adf("tampered"), created: createdAt, properties: [{ key: "com.geibee.feedback.message.v2", value: marker }] }]
    });
    await expect(readOnlyCandidate(connector(transport))).rejects.toMatchObject({ code: "feedback.integrity_error" });
  });

  it("append-only revision chainを順に検証し、最新本文をmessage detailへ反映する", async () => {
    const property = await boundProperty();
    const revisionOne = "018f0f58-c3d1-7a2b-8a4f-4c09571e5031";
    const revisionTwo = "018f0f58-c3d1-7a2b-8a4f-4c09571e5032";
    const markerOne = await codec.signMessageMarker({
      schemaVersion: "2", threadId, eventId: revisionOne, eventKind: "revision", messageId: threadId,
      expectedRevisionId: threadId, intentId: replyIntentId, requestHash, participantId,
      bodyHash: calculateFeedbackCommandHash({ body: "revision one" }),
      providerBinding: { profileId: scope.profileId, installationId: scope.installationId, objectId: "10001" }, createdAt
    });
    const markerTwo = await codec.signMessageMarker({
      schemaVersion: "2", threadId, eventId: revisionTwo, eventKind: "revision", messageId: threadId,
      expectedRevisionId: revisionOne, intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5033", requestHash, participantId,
      bodyHash: calculateFeedbackCommandHash({ body: "revision two" }),
      providerBinding: { profileId: scope.profileId, installationId: scope.installationId, objectId: "10001" },
      createdAt: "2026-08-31T12:01:00.000Z"
    });
    const transport = candidateReadTransport({ property, comments: [
      { id: "20002", body: adf("revision one"), created: createdAt, properties: [{ key: "com.geibee.feedback.message.v2", value: markerOne }] },
      { id: "20003", body: adf("revision two"), created: "2026-08-31T12:01:00.000Z", properties: [{ key: "com.geibee.feedback.message.v2", value: markerTwo }] }
    ] });
    const record = await readOnlyCandidate(connector(transport));
    expect(record.thread.messages[0]).toMatchObject({
      messageId: threadId,
      body: "revision two",
      revisions: [{ revisionId: revisionOne, body: "revision one" }, { revisionId: revisionTwo, body: "revision two" }]
    });
  });

  it("revision chainのgapをintegrity errorで拒否する", async () => {
    const property = await boundProperty();
    const marker = await codec.signMessageMarker({
      schemaVersion: "2", threadId, eventId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5031", eventKind: "revision", messageId: threadId,
      expectedRevisionId: messageId, intentId: replyIntentId, requestHash, participantId,
      bodyHash: calculateFeedbackCommandHash({ body: "orphan revision" }),
      providerBinding: { profileId: scope.profileId, installationId: scope.installationId, objectId: "10001" }, createdAt
    });
    const transport = candidateReadTransport({
      property,
      comments: [{ id: "20002", body: adf("orphan revision"), created: createdAt, properties: [{ key: "com.geibee.feedback.message.v2", value: marker }] }]
    });
    await expect(readOnlyCandidate(connector(transport))).rejects.toMatchObject({ code: "feedback.integrity_error" });
  });

  it("comment paginationを最後まで走査してintentを一意回収する", async () => {
    const property = await boundProperty();
    const marker = await codec.signMessageMarker({
      schemaVersion: "2",
      threadId,
      eventId: messageId,
      eventKind: "reply",
      messageId,
      intentId: replyIntentId,
      requestHash,
      participantId,
      bodyHash: calculateFeedbackCommandHash({ body: "reply" }),
      providerBinding: { profileId: scope.profileId, installationId: scope.installationId, objectId: "10001" },
      createdAt
    });
    const transport = new FakeTransport((request) => {
      if (request.path === "/rest/api/3/search/jql") return ok({ issues: [issue({ "com.geibee.feedback.recovery.v2": property })], isLast: true });
      if (request.path === propertyPath("com.geibee.feedback.recovery.v2")) return ok({ value: property });
      if (request.path.startsWith("/rest/api/3/issue/10001?")) return ok(issue());
      if (request.path.includes("/comment?startAt=0")) return ok({ comments: [{ id: "19999", body: {}, created: createdAt, properties: [] }], startAt: 0, maxResults: 1, total: 2 });
      if (request.path.includes("/comment?startAt=1")) return ok({ comments: [{ id: "20001", body: adf("reply"), created: createdAt, properties: [{ key: "com.geibee.feedback.message.v2", value: marker }] }], startAt: 1, maxResults: 1, total: 2 });
      if (request.path.includes("/comment/19999/properties/")) return ok({ errorMessages: ["not found"] }, 404);
      throw new Error(`unexpected request: ${request.method} ${request.path}`);
    });
    const result = await connector(transport).recoverIntent({ ...scope, threadId, intentId: replyIntentId, requestHash, operation: "feedback:reply" });
    expect(result).toEqual({ intentId: replyIntentId, state: "completed", operation: "feedback:reply", stableResultId: messageId });
    expect(transport.requests.filter((request) => request.path.includes("/comment?")).map((request) => request.path)).toHaveLength(2);
  });

  it("revisionをPUT overwriteせずappend-only commentとして保存する", async () => {
    const property = await boundProperty();
    let postedMarker: unknown;
    const transport = new FakeTransport((request) => {
      if (request.path === "/rest/api/3/search/jql") return ok({ issues: [issue({ "com.geibee.feedback.recovery.v2": property })], isLast: true });
      if (request.path === propertyPath("com.geibee.feedback.recovery.v2")) return ok({ value: property });
      if (request.path.startsWith("/rest/api/3/issue/10001?")) return ok(issue());
      if (request.path.startsWith("/rest/api/3/issue/10001/comment?")) return ok({ comments: [], startAt: 0, maxResults: 1, total: 0 });
      if (request.method === "POST" && request.path === "/rest/api/3/issue/10001/comment") {
        const body = request.body?.kind === "json" ? request.body.value as { body: unknown; properties: { value: unknown }[] } : undefined;
        postedMarker = body?.properties[0]?.value;
        return ok({ id: "20002", body: body?.body, created: createdAt, properties: body?.properties }, 201);
      }
      if (request.path.includes("/comment/20002/properties/")) return ok({ value: postedMarker });
      throw new Error(`unexpected request: ${request.method} ${request.path}`);
    });
    const revisionId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5031";
    const result = await connector(transport).appendRevision({
      ...scope,
      threadId,
      messageId: threadId,
      command: { intentId: replyIntentId, requestHash, revisionId, body: "revised", expectedRevisionId: threadId }
    });
    expect("disposition" in result && result.disposition).toBe("created");
    expect(postedMarker).toMatchObject({ eventKind: "revision", eventId: revisionId, messageId: threadId, expectedRevisionId: threadId });
    expect(transport.requests.some((request) => request.method === "PUT" && request.path.includes("/comment/"))).toBe(false);
  });

  it("同一threadの複数hitをrepair_requiredにしてissueを選ばない", async () => {
    const property = await boundProperty();
    let page = 0;
    const transport = new FakeTransport((request) => {
      if (request.path !== "/rest/api/3/search/jql") throw new Error(`unexpected request: ${request.path}`);
      page += 1;
      return page === 1
        ? ok({ issues: [issue({ "com.geibee.feedback.recovery.v2": property })], nextPageToken: "page-2", isLast: false })
        : ok({ issues: [{ ...issue({ "com.geibee.feedback.recovery.v2": property }), id: "10002", key: "TEST-2" }], isLast: true });
    });
    const result = await connector(transport).recoverIntent({ ...scope, threadId, intentId: replyIntentId, requestHash, operation: "feedback:reply" });
    expect(result).toMatchObject({ state: "repair_required", automaticWriteAllowed: false, retryDirective: "do-not-write" });
    expect(transport.requests).toHaveLength(2);
  });

  it("attachment timeout後にbinaryを再送せずmanual confirmationへ固定する", async () => {
    const property = await boundProperty();
    let reads = 0;
    const source = {
      sizeBytes: 3,
      async *read() { reads += 1; yield Uint8Array.from([1, 2, 3]); }
    };
    const transport = new FakeTransport((request) => {
      if (request.path === "/rest/api/3/search/jql") return ok({ issues: [issue({ "com.geibee.feedback.recovery.v2": property })], isLast: true });
      if (request.path === propertyPath("com.geibee.feedback.recovery.v2")) return ok({ value: property });
      if (request.path.startsWith("/rest/api/3/issue/10001?")) return ok(issue());
      if (request.path.startsWith("/rest/api/3/issue/10001/comment?")) return ok({ comments: [], startAt: 0, maxResults: 1, total: 0 });
      if (request.path === "/rest/api/3/issue/10001/properties") return ok({ keys: [{ key: "com.geibee.feedback.recovery.v2" }] });
      if (request.path.endsWith("/attachments")) {
        // 実transport相当として送信streamを一度だけ読む。
        return (async () => {
          if (request.body?.kind === "multipart-file") for await (const _chunk of request.body.content) { /* consume */ }
          throw new JiraCloudConnectorProblem({ message: "timeout", status: 504, code: "feedback.provider_timeout", retryable: true, resultUnknown: true });
        })();
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`);
    });
    const result = await connector(transport).uploadAttachment({
      ...scope,
      threadId,
      command: {
        intentId: attachmentIntentId,
        requestHash,
        attachmentId,
        filename: "evidence.txt",
        contentType: "text/plain",
        sizeBytes: 3,
        contentHash: requestHash,
        purpose: "evidence"
      },
      source
    });
    expect(result).toMatchObject({ state: "repair_required", retryDirective: "manual-confirmation", automaticWriteAllowed: false });
    expect(transport.requests.filter((request) => request.path.endsWith("/attachments"))).toHaveLength(1);
    expect(reads).toBe(1);
  });

  it("未知messageIdのattachmentをbinary upload前にfail-closedで拒否する", async () => {
    const property = await boundProperty();
    const unknownMessageId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5077";
    let uploadCalls = 0;
    let reads = 0;
    const transport = new FakeTransport((request) => {
      if (request.path === "/rest/api/3/search/jql") return ok({ issues: [issue({ "com.geibee.feedback.recovery.v2": property })], isLast: true });
      if (request.path === propertyPath("com.geibee.feedback.recovery.v2")) return ok({ value: property });
      if (request.path.startsWith("/rest/api/3/issue/10001?")) return ok(issue());
      if (request.path.startsWith("/rest/api/3/issue/10001/comment?")) return ok({ comments: [], startAt: 0, maxResults: 1, total: 0 });
      if (request.path === "/rest/api/3/issue/10001/properties") return ok({ keys: [{ key: "com.geibee.feedback.recovery.v2" }] });
      if (request.path.endsWith("/attachments")) {
        uploadCalls += 1;
        return ok([], 201);
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`);
    });
    await expect(connector(transport).uploadAttachment({
      ...scope,
      threadId,
      command: {
        intentId: attachmentIntentId,
        requestHash,
        messageId: unknownMessageId,
        attachmentId,
        filename: "evidence.txt",
        contentType: "text/plain",
        sizeBytes: 3,
        contentHash: contentHash123,
        purpose: "evidence"
      },
      source: { sizeBytes: 3, async *read() { reads += 1; yield Uint8Array.from([1, 2, 3]); } }
    })).rejects.toMatchObject({ status: 404, code: "feedback.not_found" });
    expect(uploadCalls).toBe(0);
    expect(reads).toBe(0);
    expect(transport.requests.filter((request) => request.path.endsWith("/attachments"))).toHaveLength(0);
  });

  it("attachment成功後だけ署名mappingを保存し、stable IDからstream downloadする", async () => {
    const property = await boundProperty();
    let attachmentMarker: unknown;
    let uploadedBytes = 0;
    const transport = new FakeTransport((request) => {
      if (request.path === "/rest/api/3/search/jql") return ok({ issues: [issue({ "com.geibee.feedback.recovery.v2": property })], isLast: true });
      if (request.path === propertyPath("com.geibee.feedback.recovery.v2")) return ok({ value: property });
      if (request.path.startsWith("/rest/api/3/issue/10001?")) return ok(issue());
      if (request.path.startsWith("/rest/api/3/issue/10001/comment?")) return ok({ comments: [], startAt: 0, maxResults: 1, total: 0 });
      if (request.path === "/rest/api/3/issue/10001/properties") return ok({ keys: [{ key: "com.geibee.feedback.recovery.v2" }] });
      if (request.method === "POST" && request.path.endsWith("/attachments")) return (async () => {
        if (request.body?.kind === "multipart-file") for await (const chunk of request.body.content) uploadedBytes += chunk.byteLength;
        return ok([{ id: "30001", filename: "evidence.txt", mimeType: "text/plain", size: 3, created: "2026-08-31T12:00:00.000+0000" }], 201);
      })();
      if (request.method === "PUT" && request.path === propertyPath(`com.geibee.feedback.attachment.v2.${attachmentId}`)) {
        attachmentMarker = request.body?.kind === "json" ? request.body.value : null;
        return ok(null, 204);
      }
      if (request.method === "GET" && request.path === propertyPath(`com.geibee.feedback.attachment.v2.${attachmentId}`)) return ok({ value: attachmentMarker });
      if (request.path === "/rest/api/3/attachment/30001") return ok({ id: 30001, filename: "evidence.txt", mimeType: "text/plain", size: 3, created: "2026-08-31T12:00:00.000+0000" });
      if (request.path === "/rest/api/3/attachment/content/30001") return { status: 200, headers: { "content-type": "text/plain" }, body: null, stream: (async function* () { yield Uint8Array.from([1, 2, 3]); })() };
      throw new Error(`unexpected request: ${request.method} ${request.path}`);
    });
    const repository = connector(transport);
    const result = await repository.uploadAttachment({
      ...scope,
      threadId,
      command: {
        intentId: attachmentIntentId,
        requestHash,
        attachmentId,
        filename: "evidence.txt",
        contentType: "text/plain",
        sizeBytes: 3,
        contentHash: contentHash123,
        purpose: "evidence"
      },
      source: { sizeBytes: 3, async *read() { yield Uint8Array.from([1, 2, 3]); } }
    });
    expect(result).toMatchObject({ disposition: "created", attachment: { attachmentId, filename: "evidence.txt", sizeBytes: 3 } });
    expect(uploadedBytes).toBe(3);
    expect(attachmentMarker).toMatchObject({ attachmentId, messageId: threadId, intentId: attachmentIntentId, providerAttachmentId: "30001", createdAt });

    const download = await repository.getAttachment({ ...scope, threadId, attachmentId });
    const bytes: number[] = [];
    for await (const chunk of download.body) bytes.push(...chunk);
    expect(bytes).toEqual([1, 2, 3]);
    expect(transport.requests.filter((request) => request.method === "POST" && request.path.endsWith("/attachments"))).toHaveLength(1);
  });

  it("attachment markerのmessageIdに従ってreplyへ関連付ける", async () => {
    const property = await boundProperty();
    const replyMarker = await codec.signMessageMarker({
      schemaVersion: "2", threadId, eventId: messageId, eventKind: "reply", messageId,
      intentId: replyIntentId, requestHash, participantId,
      bodyHash: calculateFeedbackCommandHash({ body: "reply with evidence" }),
      providerBinding: { profileId: scope.profileId, installationId: scope.installationId, objectId: "10001" }, createdAt
    });
    const marker = await codec.signAttachmentMarker({
      schemaVersion: "2",
      threadId,
      messageId,
      attachmentId,
      intentId: attachmentIntentId,
      requestHash,
      providerBinding: { profileId: scope.profileId, installationId: scope.installationId, objectId: "10001" },
      providerAttachmentId: "30001",
      filename: "evidence.txt",
      contentType: "text/plain",
      sizeBytes: 3,
      contentHash: contentHash123,
      createdAt
    });
    const attachmentKey = `com.geibee.feedback.attachment.v2.${attachmentId}`;
    const transport = candidateReadTransport({
      property,
      comments: [{ id: "20001", body: adf("reply with evidence"), created: createdAt, properties: [{ key: "com.geibee.feedback.message.v2", value: replyMarker }] }],
      attachmentMarkers: { [attachmentKey]: marker }
    });
    const record = await readOnlyCandidate(connector(transport));
    expect(record.thread.messages.find((item) => item.messageId === threadId)?.attachments).toEqual([]);
    expect(record.thread.messages.find((item) => item.messageId === messageId)?.attachments)
      .toEqual([{ attachmentId, filename: "evidence.txt", contentType: "text/plain", sizeBytes: 3, createdAt }]);
  });

  it("同じsizeでもdownload contentのSHA-256改変を拒否する", async () => {
    const property = await boundProperty();
    const marker = await codec.signAttachmentMarker({
      schemaVersion: "2",
      threadId,
      messageId: threadId,
      attachmentId,
      intentId: attachmentIntentId,
      requestHash,
      providerBinding: { profileId: scope.profileId, installationId: scope.installationId, objectId: "10001" },
      providerAttachmentId: "30001",
      filename: "evidence.txt",
      contentType: "text/plain",
      sizeBytes: 3,
      contentHash: contentHash123,
      createdAt
    });
    const transport = new FakeTransport((request) => {
      if (request.path === "/rest/api/3/search/jql") return ok({ issues: [issue({ "com.geibee.feedback.recovery.v2": property })], isLast: true });
      if (request.path === propertyPath("com.geibee.feedback.recovery.v2")) return ok({ value: property });
      if (request.path.startsWith("/rest/api/3/issue/10001?")) return ok(issue());
      if (request.path === propertyPath(`com.geibee.feedback.attachment.v2.${attachmentId}`)) return ok({ value: marker });
      if (request.path === "/rest/api/3/attachment/30001") return ok({ id: "30001", filename: "evidence.txt", mimeType: "text/plain", size: 3, created: createdAt });
      if (request.path === "/rest/api/3/attachment/content/30001") {
        return { status: 200, headers: { "content-type": "text/plain" }, body: null, stream: (async function* () { yield Uint8Array.from([1, 2, 4]); })() };
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`);
    });
    const download = await connector(transport).getAttachment({ ...scope, threadId, attachmentId });
    const consume = async () => {
      for await (const _chunk of download.body) { /* 完了時hash検証まで消費する */ }
    };
    await expect(consume()).rejects.toMatchObject({ code: "feedback.integrity_error" });
  });

  it("binary upload成功後のmapping障害は再uploadせずmanual confirmationへ閉じる", async () => {
    const property = await boundProperty();
    let reads = 0;
    const transport = new FakeTransport((request) => {
      if (request.path === "/rest/api/3/search/jql") return ok({ issues: [issue({ "com.geibee.feedback.recovery.v2": property })], isLast: true });
      if (request.path === propertyPath("com.geibee.feedback.recovery.v2")) return ok({ value: property });
      if (request.path.startsWith("/rest/api/3/issue/10001?")) return ok(issue());
      if (request.path.startsWith("/rest/api/3/issue/10001/comment?")) return ok({ comments: [], startAt: 0, maxResults: 1, total: 0 });
      if (request.path === "/rest/api/3/issue/10001/properties") return ok({ keys: [{ key: "com.geibee.feedback.recovery.v2" }] });
      if (request.method === "POST" && request.path.endsWith("/attachments")) return (async () => {
        if (request.body?.kind === "multipart-file") for await (const _chunk of request.body.content) reads += 1;
        return ok([{ id: "30001", filename: "evidence.txt", mimeType: "text/plain", size: 3, created: "2026-08-31T12:00:00.000+0000" }], 201);
      })();
      if (request.method === "PUT" && request.path === propertyPath(`com.geibee.feedback.attachment.v2.${attachmentId}`)) {
        return ok({ errorMessages: ["synthetic"] }, 503);
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`);
    });
    const result = await connector(transport).uploadAttachment({
      ...scope,
      threadId,
      command: {
        intentId: attachmentIntentId,
        requestHash,
        attachmentId,
        filename: "evidence.txt",
        contentType: "text/plain",
        sizeBytes: 3,
        contentHash: requestHash,
        purpose: "evidence"
      },
      source: { sizeBytes: 3, async *read() { yield Uint8Array.from([1, 2, 3]); } }
    });
    expect(result).toMatchObject({ state: "repair_required", retryDirective: "manual-confirmation", automaticWriteAllowed: false });
    expect(transport.requests.filter((request) => request.method === "POST" && request.path.endsWith("/attachments"))).toHaveLength(1);
    expect(reads).toBe(1);
  });

  it("上限超過と未対応media typeをprovider write前に拒否する", async () => {
    const transport = new FakeTransport(() => { throw new Error("HTTPは呼ばれません"); });
    const repository = connector(transport);
    const base = {
      ...scope,
      threadId,
      source: { sizeBytes: 1025, async *read() { yield new Uint8Array(); } },
      command: {
        intentId: attachmentIntentId,
        requestHash,
        attachmentId,
        filename: "large.bin",
        contentType: "text/plain",
        sizeBytes: 1025,
        contentHash: requestHash,
        purpose: "evidence" as const
      }
    };
    await expect(repository.uploadAttachment(base)).rejects.toMatchObject({ status: 413, code: "feedback.payload_too_large" });
    await expect(repository.uploadAttachment({
      ...base,
      source: { ...base.source, sizeBytes: 1 },
      command: { ...base.command, sizeBytes: 1, contentType: "application/x-unsupported" }
    })).rejects.toMatchObject({ status: 415, code: "feedback.unsupported_media_type" });
    expect(transport.requests).toHaveLength(0);
  });
});
