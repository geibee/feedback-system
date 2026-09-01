import { describe, expect, it, vi } from "vitest";
import {
  FeedbackClientProblem,
  createFetchFeedbackTransport,
  createFeedbackHttpClient,
  type FeedbackHttpRequest,
  type FeedbackHttpResponse,
  type FeedbackRequestCredentials
} from "./index.js";
import { createFakeFeedbackClient, createTrackedUploadSource } from "./testing.js";

describe("FeedbackClientPort契約", () => {
  it("wire problemを型付きerrorとして保持する", () => {
    const error = new FeedbackClientProblem({
      type: "https://feedback.example/problems/forbidden",
      title: "許可されていません",
      status: 403,
      code: "feedback.forbidden",
      retryable: false
    });
    expect(error.name).toBe("FeedbackClientProblem");
    expect(error.problem.code).toBe("feedback.forbidden");
  });
});

describe("generic HTTP transport", () => {
  const response = (status: number, value: unknown, headers: Readonly<Record<string, string>> = {
    "content-type": status >= 400 ? "application/problem+json" : "application/json"
  }): FeedbackHttpResponse => ({
    status,
    headers,
    async json() { return value; }
  });

  it("same-origin pathとqueryを構成しwire wrapperをbrowser型へ変換する", async () => {
    const requests: FeedbackHttpRequest[] = [];
    const profile = {
      schemaVersion: "2" as const,
      profileId: "inventory",
      displayName: "Inventory",
      capabilities: {
        backendOperations: ["feedback:read" as const],
        discovery: { workspaces: "supported" as const, resources: "supported" as const },
        operationGuarantees: { create: "recoverable" as const, reply: "best-effort" as const, revision: "best-effort" as const, attachmentUpload: "best-effort" as const },
        creationFields: [], maximumAttachmentBytes: 100, attachmentContentTypes: ["text/plain"]
      },
      effectivePermissions: ["feedback:read" as const]
    };
    const client = createFeedbackHttpClient({ transport: {
      async request(request) { requests.push(request); return response(200, { profile }); }
    } });
    await expect(client.getProfile({
      profileId: "inventory",
      workspaceId: "OPS",
      resource: { kind: "record", key: "order/001" }
    })).resolves.toEqual(profile);
    expect(requests[0]).toMatchObject({
      method: "GET",
      path: "/internal/feedback/v2/profiles/inventory?workspaceId=OPS&resourceKind=record&resourceKey=order%2F001"
    });
  });

  it("FeedbackProblemを保持し、契約外error本文は公開しない", async () => {
    const validClient = createFeedbackHttpClient({ transport: {
      async request() {
        return response(429, {
          type: "https://feedback.example/problems/rate-limited",
          title: "rate limited",
          status: 429,
          code: "feedback.rate_limited",
          retryable: true,
          retryAfterSeconds: 3
        }, { "Retry-After": "3", "Content-Type": "application/problem+json" });
      }
    } });
    const valid = await validClient.listWorkspaces({ profileId: "inventory" }).catch((error: unknown) => error);
    expect(valid).toBeInstanceOf(FeedbackClientProblem);
    expect((valid as FeedbackClientProblem).problem).toMatchObject({ code: "feedback.rate_limited", retryAfterSeconds: 3 });

    const invalidClient = createFeedbackHttpClient({ transport: {
      async request() { return response(502, { secret: "provider-body" }, { "Content-Type": "application/problem+json" }); }
    } });
    const invalid = await invalidClient.listWorkspaces({ profileId: "inventory" }).catch((error: unknown) => error);
    expect(invalid).toBeInstanceOf(FeedbackClientProblem);
    expect(JSON.stringify((invalid as FeedbackClientProblem).problem)).not.toContain("provider-body");
  });

  it("multipart sourceを一度だけ消費し、結果不明responseをそのまま返す", async () => {
    const source = createTrackedUploadSource([new Uint8Array([1, 2, 3])]);
    let bodyChunks = 0;
    const client = createFeedbackHttpClient({
      createMultipartBoundary: () => "phase3-boundary",
      transport: {
        async request(request) {
          expect(request.headers["Content-Type"]).toBe("multipart/form-data; boundary=phase3-boundary");
          expect(request.headers["X-Feedback-CSRF"]).toBe("1");
          if (typeof request.body === "string" || request.body === undefined) throw new Error("stream bodyが必要です");
          for await (const _chunk of request.body) bodyChunks += 1;
          return response(202, {
            intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5031",
            state: "repair_required",
            operation: "feedback:attachment:upload",
            detail: "利用者による確認が必要です",
            automaticWriteAllowed: false,
            retryDirective: "manual-confirmation"
          });
        }
      }
    });
    await expect(client.uploadAttachment({
      profileId: "inventory", workspaceId: "OPS", resource: { kind: "record", key: "order-001" },
      threadId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5001",
      command: {
        attachmentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5030",
        intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5031",
        requestHash: `sha256:${"1".repeat(64)}`,
        filename: "phase3.txt", contentType: "text/plain", sizeBytes: 3,
        contentHash: `sha256:${"2".repeat(64)}`, purpose: "evidence"
      }, source
    })).resolves.toMatchObject({ state: "repair_required", automaticWriteAllowed: false });
    expect(source.streamCalls).toBe(1);
    expect(bodyChunks).toBe(4);
  });

  it("intent回収のrequestHashをqueryへ漏らさず必須headerで送る", async () => {
    let captured: FeedbackHttpRequest | undefined;
    const client = createFeedbackHttpClient({ transport: {
      async request(request) {
        captured = request;
        return response(200, {
          intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5031",
          state: "completed",
          operation: "feedback:create",
          stableResultId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5001"
        });
      }
    } });
    const requestHash = `sha256:${"1".repeat(64)}`;
    await client.recoverIntent({
      ...scopeForClient(),
      threadId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5001",
      intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5031",
      requestHash,
      operation: "feedback:create"
    });
    expect(captured?.path).toBe(
      `/internal/feedback/v2/profiles/inventory/workspaces/OPS/intents/018f0f58-c3d1-7a2b-8a4f-4c09571e5031` +
      `?resourceKind=record&resourceKey=order-001&threadId=018f0f58-c3d1-7a2b-8a4f-4c09571e5001` +
      `&operation=feedback%3Acreate`
    );
    expect(captured?.headers["X-Feedback-Request-Hash"]).toBe(requestHash);
  });

  it("public-profile participant credentialを認証前のsame-origin POSTで発行する", async () => {
    let captured: FeedbackHttpRequest | undefined;
    const client = createFeedbackHttpClient({
      credentialProvider() { throw new Error("participant発行でcredentialを要求してはいけません"); },
      transport: {
        async request(request) {
          captured = request;
          return response(201, {
            participantId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5003",
            credential: "v2." + "x".repeat(64)
          });
        }
      }
    });
    await expect(client.issueParticipant({
      profileId: "inventory",
      browserProfileId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5020"
    })).resolves.toMatchObject({ participantId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5003" });
    expect(captured).toMatchObject({
      method: "POST",
      path: "/internal/feedback/v2/profiles/inventory/participants",
      headers: { "X-Feedback-CSRF": "1", "Content-Type": "application/json; charset=utf-8" }
    });
    expect(JSON.parse(String(captured?.body))).toEqual({ browserProfileId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5020" });
  });

  it("request scopeごとにBearerまたはparticipant credentialを解決し、POSTへCSRFを固定する", async () => {
    const requests: FeedbackHttpRequest[] = [];
    const scopes: unknown[] = [];
    const client = createFeedbackHttpClient({
      credentialProvider(scope) {
        scopes.push(scope);
        return scope.operation === "feedback:create"
          ? { participantCredential: "participant.signed.credential" }
          : { bearerToken: "signed.grant.jwt" };
      },
      transport: {
        async request(request) {
          requests.push(request);
          if (request.method === "GET") return response(200, { items: [], nextCursor: null });
          return response(202, {
            intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5051",
            state: "pending",
            operation: "feedback:create",
            retryAfterSeconds: 2,
            automaticWriteAllowed: false
          });
        }
      }
    });
    await client.listThreads(scopeForClient());
    await client.createThread({ profileId: "inventory", workspaceId: "OPS", command: {
      intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5051",
      requestHash: `sha256:${"3".repeat(64)}`,
      threadId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5001",
      resource: { kind: "record", key: "order-001" },
      title: "credential test",
      body: "本文"
    } });
    expect(scopes).toEqual([
      { profileId: "inventory", workspaceId: "OPS", resource: { kind: "record", key: "order-001" }, operation: "feedback:read" },
      { profileId: "inventory", workspaceId: "OPS", resource: { kind: "record", key: "order-001" }, operation: "feedback:create" }
    ]);
    expect(requests[0]?.headers).toMatchObject({ Authorization: "Bearer signed.grant.jwt" });
    expect(requests[0]?.headers["X-Feedback-CSRF"]).toBeUndefined();
    expect(requests[1]?.headers).toMatchObject({
      "X-Feedback-CSRF": "1",
      "X-Feedback-Participant-Credential": "participant.signed.credential"
    });
    expect(requests[1]?.headers.Authorization).toBeUndefined();
  });

  it("credential providerなしではsame-origin credentialとPOST CSRFだけを使用する", async () => {
    let captured: FeedbackHttpRequest | undefined;
    const client = createFeedbackHttpClient({ transport: {
      async request(request) {
        captured = request;
        return response(202, {
          intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5051",
          state: "pending",
          operation: "feedback:create",
          retryAfterSeconds: 2,
          automaticWriteAllowed: false
        });
      }
    } });
    await client.createThread({ profileId: "inventory", workspaceId: "OPS", command: {
      intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5051",
      requestHash: `sha256:${"3".repeat(64)}`,
      threadId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5001",
      resource: { kind: "record", key: "order-001" }, title: "remote authorization", body: "本文"
    } });
    expect(captured?.headers["X-Feedback-CSRF"]).toBe("1");
    expect(captured?.headers.Authorization).toBeUndefined();
    expect(captured?.headers["X-Feedback-Participant-Credential"]).toBeUndefined();
  });

  it.each([
    ["改行", { bearerToken: "signed\ngrant" }],
    ["空文字", { participantCredential: "" }],
    ["長さ超過", { bearerToken: "a".repeat(8_193) }],
    ["同時指定", { bearerToken: "signed.grant", participantCredential: "participant.credential" }]
  ] satisfies readonly (readonly [string, FeedbackRequestCredentials])[])(
    "credentialの%sをtransport前にfail-closedにする",
    async (_name, credentials) => {
      const transport = { request: vi.fn(async () => response(200, { items: [], nextCursor: null })) };
      const client = createFeedbackHttpClient({ transport, credentialProvider: () => credentials });
      await expect(client.listThreads(scopeForClient())).rejects.toThrow(/credential|bearerToken/iu);
      expect(transport.request).not.toHaveBeenCalled();
    }
  );

  it("attachment headerをbrowser descriptorへ写像し、bodyをbufferせず返す", async () => {
    let bodyRead = false;
    const body = (async function* () { bodyRead = true; yield new Uint8Array([1, 2, 3]); })();
    const client = createFeedbackHttpClient({ transport: {
      async request() {
        return {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Length": "3",
            "Content-Disposition": "attachment; filename*=UTF-8''phase3.txt"
          },
          async json() { throw new Error("JSONではありません"); },
          body
        };
      }
    } });
    const result = await client.getAttachment({ ...scopeForClient(), threadId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5001", attachmentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5030" });
    expect(result).toMatchObject({ filename: "phase3.txt", contentType: "text/plain", sizeBytes: 3 });
    expect(bodyRead).toBe(false);
    for await (const _chunk of result.body) { /* consumerが明示して初めて読む */ }
    expect(bodyRead).toBe(true);
  });

  it("fetch adapterがJSON bodyを先にlockせず、同一origin設定を固定する", async () => {
    let readerCalls = 0;
    const transport = createFetchFeedbackTransport(async (_input, init) => {
      expect(init).toMatchObject({ credentials: "same-origin", cache: "no-store" });
      return {
        status: 200,
        headers: { get: () => "application/json", forEach(callback) { callback("application/json", "content-type"); } },
        body: { getReader() { readerCalls += 1; return { async read() { return { done: true }; } }; } },
        async json() {
          expect(readerCalls).toBe(0);
          return { items: [], nextCursor: null };
        }
      };
    });
    const client = createFeedbackHttpClient({ transport });
    await expect(client.listWorkspaces({ profileId: "inventory" })).resolves.toEqual({ items: [], nextCursor: null });
    expect(readerCalls).toBe(0);
  });

  it("fetch接続失敗をprovider本文なしのretryable problemへ正規化する", async () => {
    const transport = createFetchFeedbackTransport(async () => { throw new Error("credential-like-upstream-detail"); });
    const client = createFeedbackHttpClient({ transport });
    const error = await client.listWorkspaces({ profileId: "inventory" }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(FeedbackClientProblem);
    expect((error as FeedbackClientProblem).problem).toMatchObject({
      status: 503,
      code: "feedback.provider_unavailable",
      retryable: true
    });
    expect(JSON.stringify((error as FeedbackClientProblem).problem)).not.toContain("credential-like-upstream-detail");
  });
});

function scopeForClient() {
  return { profileId: "inventory", workspaceId: "OPS", resource: { kind: "record", key: "order-001" } };
}

describe("FeedbackClientPort fake", () => {
  it("scopeとAbortSignalを失わず呼び出しを記録する", async () => {
    const signal = { aborted: false, subscribe: () => () => undefined };
    const client = createFakeFeedbackClient({
      async listThreads(query) {
        expect(query.resource).toEqual({ kind: "record", key: "order-001" });
        return { items: [], nextCursor: null };
      }
    });
    await client.listThreads({
      profileId: "inventory",
      workspaceId: "OPS",
      resource: { kind: "record", key: "order-001" }
    }, { signal });
    expect(client.count("listThreads")).toBe(1);
    expect(client.calls[0]?.options?.signal).toBe(signal);
  });

  it("upload sourceを暗黙に再読込しない", async () => {
    const source = createTrackedUploadSource([new Uint8Array([1, 2, 3])]);
    const client = createFakeFeedbackClient({
      async uploadAttachment(query) {
        for await (const _chunk of query.source.stream()) { /* transportによる一回の消費 */ }
        return {
          disposition: "created",
          intentId: query.command.intentId,
          attachment: {
            attachmentId: query.command.attachmentId,
            filename: query.command.filename,
            contentType: query.command.contentType,
            sizeBytes: query.command.sizeBytes,
            createdAt: "2026-08-31T06:02:00.000Z"
          }
        };
      }
    });
    await client.uploadAttachment({
      profileId: "inventory",
      workspaceId: "OPS",
      resource: { kind: "record", key: "order-001" },
      threadId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5001",
      command: {
        attachmentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5030",
        intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5031",
        requestHash: `sha256:${"1".repeat(64)}`,
        filename: "phase2.txt",
        contentType: "text/plain",
        sizeBytes: 3,
        contentHash: `sha256:${"2".repeat(64)}`,
        purpose: "evidence"
      },
      source
    });
    expect(source.streamCalls).toBe(1);
    expect(source.yieldedChunks).toBe(1);
  });
});
