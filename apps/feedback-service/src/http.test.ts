import { createThreadReferencePort } from "./thread-reference.js";
import type { FeedbackCapabilitiesV2 } from "@geibee/feedback-contracts/v2";
import type { FeedbackProviderProfileV2, FeedbackServiceSettingsV2 } from "@geibee/feedback-contracts/v2/server";
import { createFakeFeedbackRepository } from "@geibee/feedback-connector-sdk/testing";
import { FeedbackConnectorProblem } from "@geibee/feedback-connector-sdk";
import { FeedbackGatewayApplicationService } from "@geibee/feedback-gateway";
import { describe, expect, it } from "vitest";
import { createFeedbackAuthorizationRuntime } from "./authorization.js";
import { createFeedbackHttpHandler } from "./http.js";
import { issueFeedbackParticipantCredential } from "./participant.js";

const origin = "https://app.example";
const resource = { kind: "record", key: "order-001" } as const;
const profile: FeedbackProviderProfileV2 = {
  schemaVersion: "2", profileId: "public", displayName: "Public", connectorKey: "fake", installationId: "fake",
  workspacePolicy: { workspaceIds: ["OPS"], workspaceDiscovery: "supported", resourceDiscovery: "supported" },
  authorization: { mode: "public-profile" },
  policy: { operations: ["feedback:read", "feedback:create"], resourceKinds: ["record"] },
  capabilities: {
    operations: ["feedback:read", "feedback:create"], discovery: { workspaces: "supported", resources: "supported" },
    operationGuarantees: { create: "recoverable", reply: "unsupported", revision: "unsupported", attachmentUpload: "unsupported" },
    creationFields: [], maximumMetadataBytes: 32768, projectionValidation: "envelope-required", uniqueThreadLookup: true
  },
  secretRefs: {
    providerCredential: { kind: "server-secret", id: "PROVIDER" }, envelopeKeyRing: { kind: "server-secret", id: "ENVELOPE" },
    participantCredentialKeyRing: { kind: "server-secret", id: "PARTICIPANT_RING" }, participantIdDerivationKey: { kind: "server-secret", id: "DERIVATION" }
  }
};
const settings: FeedbackServiceSettingsV2 = {
  schemaVersion: "2", serviceId: "test", profileFiles: ["/profile.json"], signedGrantIssuers: [],
  remoteAuthorizationProfiles: [{ id: "remote", endpoint: "https://auth.example/decision", timeoutMilliseconds: 2000,
    credentialRef: { kind: "server-secret", id: "REMOTE" } }],
  jwksCache: { maximumIssuers: 1, maximumKeysPerIssuer: 1, maximumTtlSeconds: 1 }
};
const capabilities: FeedbackCapabilitiesV2 = {
  backendOperations: ["feedback:read", "feedback:create"],
  discovery: { workspaces: "supported" as const, resources: "supported" as const },
  operationGuarantees: { create: "recoverable" as const, reply: "unsupported" as const, revision: "unsupported" as const, attachmentUpload: "unsupported" as const },
  creationFields: [], maximumAttachmentBytes: 1024, attachmentContentTypes: ["text/plain"]
};
const key = Buffer.alloc(32, 7).toString("base64url");
const ring = JSON.stringify({ activeKid: "current", keys: [{ kid: "current", key }] });
const secretResolver = { async resolve(id: string) { return ["PARTICIPANT_RING", "REFERENCE_RING"].includes(id) ? ring : key; } };

function fixture(
  repository = createFakeFeedbackRepository({ async getCapabilities() { return capabilities; } }),
  operationTimeoutMilliseconds = 1000,
  bindParticipant?: Parameters<typeof createFeedbackHttpHandler>[0]["bindParticipant"],
  activeProfile: FeedbackProviderProfileV2 = profile,
  remoteHttp?: Parameters<typeof createFeedbackAuthorizationRuntime>[0]["httpClient"],
  acceptProjection = false
) {
  const profileLoader = { async loadProfiles() { return [activeProfile]; } };
  const authorization = createFeedbackAuthorizationRuntime({
    settings, profileLoader, secretResolver,
    httpClient: remoteHttp ?? { async request() { throw new Error("unexpected HTTP"); } }
  });
  const gateway = new FeedbackGatewayApplicationService({
    profileLoader,
    authorizationPorts: authorization.ports,
    connectors: new Map([["fake", repository]]),
    threadReferences: createThreadReferencePort({ secretResolver, audience: origin }),
    projectionVerifier: { async verify(_candidate, record) {
      return acceptProjection ? { valid: true as const, record: record as never }
        : { valid: false as const, reason: "signature" as const };
    } }
  });
  const handler = createFeedbackHttpHandler({
    gateway, authorization, profileLoader, secretResolver,
    expectedOrigin: origin, basePath: "/internal/feedback/v2", maximumRequestBytes: 4096, operationTimeoutMilliseconds,
    ...(bindParticipant ? { bindParticipant } : {})
  });
  return { handler, repository };
}

describe("Feedback Service v2 HTTP adapter", () => {
  it("opt-inで参照を発行し、別scope・改変・認可取消しをprovider呼出し前に拒否する", async () => {
    const activeProfile: FeedbackProviderProfileV2 = { ...profile, policy: { ...profile.policy, operations: [...profile.policy.operations] },
      secretRefs: { ...profile.secretRefs, threadReferenceKeyRing: { kind: "server-secret", id: "REFERENCE_RING" } } };
    const threadId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5001";
    const thread = { threadId, resource, title: "title", status: "open" as const, createdAt: "2026-09-07T00:00:00Z",
      updatedAt: "2026-09-07T00:00:00Z", messageCount: 1, messages: [] };
    const candidate = { providerRef: { providerKey: "fake", objectId: "private-1" }, projection: {} as never };
    let searchUnavailable = false;
    const repository = createFakeFeedbackRepository({
      supportsThreadReferences: true,
      async getCapabilities() { return capabilities; },
      async findThreadCandidatesById(_query, options) {
        if (searchUnavailable) expect(options?.threadRef).toEqual(candidate.providerRef);
        return [candidate];
      },
      async readCandidate() { return { ...candidate, envelope: null, legacyMetadata: null, thread }; },
      async createThread(query, options) {
        options?.onThreadResolved?.(candidate.providerRef);
        return { disposition: "created", intentId: query.command.intentId, thread };
      }
    });
    const { handler } = fixture(repository, 1000, undefined, activeProfile, undefined, true);
    const path = origin + "/internal/feedback/v2/profiles/public/workspaces/OPS/threads/" + threadId + "?resourceKind=record&resourceKey=order-001";
    expect((await (await handler(new Request(path))).json()).thread.threadReference).toBeUndefined();
    const headers = { "X-Feedback-Accept-Thread-Reference": "1" };
    const token = (await (await handler(new Request(path, { headers }))).json()).thread.threadReference;
    expect(token).toMatch(/^ftr1\./u);
    searchUnavailable = true;
    const requestHeaders = { ...headers, "X-Feedback-Thread-Reference": token };
    expect((await handler(new Request(path, { headers: requestHeaders }))).status).toBe(200);
    const before = repository.count("findThreadCandidatesById");
    expect((await handler(new Request(path.replace("order-001", "other"), { headers: requestHeaders }))).status).toBe(409);
    expect((await handler(new Request(path, { headers: { ...requestHeaders, "X-Feedback-Thread-Reference": token + "A" } }))).status).toBe(409);
    activeProfile.policy.operations = [];
    expect((await handler(new Request(path, { headers: requestHeaders }))).status).toBe(403);
    expect(repository.count("findThreadCandidatesById")).toBe(before);
  });

  it("remote profileの許可集合を照会し、自己編集のread／reviseを別々に認可する", async () => {
    const operations = ["feedback:read", "feedback:create", "feedback:revise"] as const;
    const activeProfile: FeedbackProviderProfileV2 = { ...profile,
      authorization: { mode: "remote-authorization", authorizationProfileRef: "remote", subjectSource: "authenticated-adapter" },
      policy: { ...profile.policy, operations: [...operations] }, capabilities: { ...profile.capabilities, operations: [...operations] }
    };
    const threadId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5301";
    const message = { messageId: threadId, body: "before", author: { kind: "participant" as const,
      participantId: threadId, displayName: "本人", isCurrentParticipant: true }, createdAt: "2026-09-01T00:00:00Z",
      orderingKey: { occurredAt: "2026-09-01T00:00:00Z", eventId: threadId }, revisions: [], attachments: [] };
    const thread = { threadId, title: "title", resource, status: "open" as const, createdAt: message.createdAt,
      updatedAt: message.createdAt, messageCount: 1, messages: [message] };
    const repository = createFakeFeedbackRepository({
      async getCapabilities() { return { ...capabilities, backendOperations: [...operations] }; },
      async findThreadCandidatesById() { return [{ providerRef: { providerKey: "fake", objectId: "1" }, projection: {} as never }]; },
      async readCandidate(candidate) { return { providerRef: candidate.providerRef, envelope: null, legacyMetadata: null, thread }; },
      async appendRevision(query) { return { disposition: "created", intentId: query.command.intentId, message }; }
    });
    const requested: string[][] = [];
    let denyRead = false;
    const { handler } = fixture(repository, 1000, undefined, activeProfile, { async request(input) {
      const request = JSON.parse(input.body!);
      requested.push(request.requestedOperations);
      return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: "1",
        target: request.target, subject: request.subject,
        allowedOperations: request.requestedOperations.filter((op: string) => op === "feedback:revise" || op === "feedback:read" && !denyRead) }) };
    } }, true);
    const context = { authenticatedSubjectId: "host-user" };
    const result = await handler(new Request(`${origin}/internal/feedback/v2/profiles/public?workspaceId=OPS&resourceKind=record&resourceKey=order-001`), context);
    expect(await result.json()).toMatchObject({ profile: { effectivePermissions: ["feedback:read", "feedback:revise"] } });
    const request = () => new Request(`${origin}/internal/feedback/v2/profiles/public/workspaces/OPS/threads/${threadId}/messages/${threadId}/revisions?resourceKind=record&resourceKey=order-001`, {
      method: "POST", headers: { origin, "x-feedback-csrf": "1", "content-type": "application/json" },
      body: JSON.stringify({ intentId: threadId, revisionId: threadId, expectedRevisionId: threadId, requestHash: `sha256:${"1".repeat(64)}`, body: "after" })
    });
    expect((await handler(request(), context)).status).toBe(201);
    expect(requested).toEqual([[...operations], ["feedback:read"], ["feedback:revise"]]);
    denyRead = true;
    expect((await handler(request(), context)).status).toBe(403);
    expect(repository.count("appendRevision")).toBe(1);
  });

  it("日本語添付名をASCII fallbackとfilename*で返す", async () => {
    const operations = ["feedback:read", "feedback:attachment:read"] as const;
    const activeProfile = { ...profile, policy: { ...profile.policy, operations: [...operations] },
      capabilities: { ...profile.capabilities, operations: [...operations] } };
    const repository = createFakeFeedbackRepository({
      async getCapabilities() { return { ...capabilities, backendOperations: [...operations] }; },
      async getAttachment() { return { filename: "証跡.png", contentType: "image/png", sizeBytes: 1,
        body: (async function* () { yield Uint8Array.of(1); })() }; }
    });
    const { handler } = fixture(repository, 1000, undefined, activeProfile);
    const participant = await issueFeedbackParticipantCredential({ profile: activeProfile,
      browserProfileId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5301", origin, secretResolver });
    const id = "018f0f58-c3d1-7a2b-8a4f-4c09571e5301";
    const response = await handler(new Request(`${origin}/internal/feedback/v2/profiles/public/workspaces/OPS/threads/${id}/attachments/${id}/content?resourceKind=record&resourceKey=order-001`,
      { headers: { "x-feedback-participant-credential": participant.credential } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="__.png"; filename*=UTF-8''${encodeURIComponent("証跡.png")}`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.of(1));
  });
  it("public-profile participant credentialを公開routeから発行し、他modeへfallbackしない", async () => {
    const { handler } = fixture();
    const browserProfileId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5303";
    const path = `${origin}/internal/feedback/v2/profiles/public/participants`;
    const missingCsrf = await handler(new Request(path, {
      method: "POST", headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ browserProfileId })
    }));
    expect(missingCsrf.status).toBe(403);
    const issued = await handler(new Request(path, {
      method: "POST", headers: { "content-type": "application/json", origin, "x-feedback-csrf": "1" },
      body: JSON.stringify({ browserProfileId })
    }));
    expect(issued.status).toBe(201);
    expect(await issued.json()).toMatchObject({ participantId: expect.any(String), credential: expect.stringMatching(/^v2\./u) });

    const signedProfile: FeedbackProviderProfileV2 = {
      ...profile,
      authorization: { mode: "signed-grant", issuerProfileRef: "issuer" }
    };
    const signed = fixture(undefined, 1000, undefined, signedProfile).handler;
    const denied = await signed(new Request(path, {
      method: "POST", headers: { "content-type": "application/json", origin, "x-feedback-csrf": "1" },
      body: JSON.stringify({ browserProfileId })
    }));
    expect(denied.status).toBe(403);
  });

  it("same-origin profile requestだけを処理し、security headerを付ける", async () => {
    const { handler, repository } = fixture();
    const response = await handler(new Request(`${origin}/internal/feedback/v2/profiles/public?workspaceId=OPS&resourceKind=record&resourceKey=order-001`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()) as object).toMatchObject({ profile: { effectivePermissions: ["feedback:read", "feedback:create"] } });
    expect(repository.count("getCapabilities")).toBe(1);

    const crossOrigin = await handler(new Request("https://evil.example/internal/feedback/v2/profiles/public?workspaceId=OPS&resourceKind=record&resourceKey=order-001"));
    expect(crossOrigin.status).toBe(403);
    expect(repository.count("getCapabilities")).toBe(1);
  });

  it("unsafe requestへOrigin、CSRF、participant credentialを必須化する", async () => {
    const repository = createFakeFeedbackRepository({
      async getCapabilities() { return capabilities; },
      async createThread(query) {
        return {
          disposition: "created",
          intentId: query.command.intentId,
          thread: {
            threadId: query.command.threadId, resource, title: query.command.title, status: "open",
            createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", messageCount: 1,
            messages: [{
              messageId: query.command.threadId, body: query.command.body,
              author: { kind: "unknown", displayName: "Unknown" }, createdAt: "2026-09-01T00:00:00.000Z",
              orderingKey: { occurredAt: "2026-09-01T00:00:00.000Z", eventId: query.command.threadId }, revisions: [], attachments: []
            }]
          }
        };
      }
    });
    const { handler } = fixture(repository);
    const command = {
      intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5301", requestHash: `sha256:${"1".repeat(64)}`,
      threadId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5302", resource, title: "title", body: "body"
    };
    const missingCsrf = await handler(new Request(`${origin}/internal/feedback/v2/profiles/public/workspaces/OPS/threads`, {
      method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(command)
    }));
    expect(missingCsrf.status).toBe(403);
    const missingParticipant = await handler(new Request(`${origin}/internal/feedback/v2/profiles/public/workspaces/OPS/threads`, {
      method: "POST", headers: { "content-type": "application/json", origin, "x-feedback-csrf": "1" }, body: JSON.stringify(command)
    }));
    expect(missingParticipant.status).toBe(403);

    const participantResponse = await handler(new Request(`${origin}/internal/feedback/v2/profiles/public/participants`, {
      method: "POST", headers: { "content-type": "application/json", origin, "x-feedback-csrf": "1" },
      body: JSON.stringify({ browserProfileId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5303" })
    }));
    const participant = await participantResponse.json() as { credential: string };
    const created = await handler(new Request(`${origin}/internal/feedback/v2/profiles/public/workspaces/OPS/threads`, {
      method: "POST",
      headers: {
        "content-type": "application/json", origin, "x-feedback-csrf": "1",
        "x-feedback-participant-credential": participant.credential
      },
      body: JSON.stringify(command)
    }));
    expect(created.status).toBe(201);
    expect(repository.count("createThread")).toBe(1);
  });

  it("intent回収のrequest hashをOpenAPIどおりheaderだけから受ける", async () => {
    const repository = createFakeFeedbackRepository({
      async getCapabilities() { return capabilities; },
      async recoverIntent(query) {
        return { intentId: query.intentId, state: "not_found", operation: query.operation };
      }
    });
    const { handler } = fixture(repository);
    const participant = await issueFeedbackParticipantCredential({
      profile, browserProfileId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5311", origin, secretResolver
    });
    const base = `${origin}/internal/feedback/v2/profiles/public/workspaces/OPS/intents/018f0f58-c3d1-7a2b-8a4f-4c09571e5312` +
      `?threadId=018f0f58-c3d1-7a2b-8a4f-4c09571e5313&operation=feedback%3Acreate&resourceKind=record&resourceKey=order-001`;
    const headers = { "x-feedback-participant-credential": participant.credential };
    expect((await handler(new Request(`${base}&requestHash=${encodeURIComponent(`sha256:${"1".repeat(64)}`)}`, { headers }))).status).toBe(400);
    expect((await handler(new Request(base, { headers }))).status).toBe(400);
    const recovered = await handler(new Request(base, {
      headers: { ...headers, "x-feedback-request-hash": `sha256:${"1".repeat(64)}` }
    }));
    expect(recovered.status).toBe(200);
    expect(repository.count("recoverIntent")).toBe(1);
  });

  it("resource keyをOpenAPIと同じ512文字まで受理する", async () => {
    const { handler, repository } = fixture();
    const request = (key: string) => handler(new Request(
      `${origin}/internal/feedback/v2/profiles/public?workspaceId=OPS&resourceKind=record&resourceKey=${key}`
    ));
    expect((await request("a".repeat(512))).status).toBe(200);
    expect((await request("a".repeat(513))).status).toBe(400);
    expect(repository.count("getCapabilities")).toBe(1);
  });

  it("public-profileのcredentialをreadでも検証してrequest accessへ束縛する", async () => {
    const bindings: Array<{ access: object; principal: { participantId: string } | null }> = [];
    const { handler } = fixture(undefined, 1000, (binding) => bindings.push(binding));
    const participant = await issueFeedbackParticipantCredential({
      profile,
      browserProfileId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5310",
      origin,
      secretResolver
    });
    const response = await handler(new Request(
      `${origin}/internal/feedback/v2/profiles/public?workspaceId=OPS&resourceKind=record&resourceKey=order-001`,
      { headers: { "x-feedback-participant-credential": participant.credential } }
    ));
    expect(response.status).toBe(200);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.principal?.participantId).toBe(participant.participantId);
  });

  it("strict DTO、content type、body上限をConnector前に拒否する", async () => {
    const { handler, repository } = fixture();
    const base = `${origin}/internal/feedback/v2/profiles/public/workspaces/OPS/threads`;
    const headers = { origin, "x-feedback-csrf": "1" };
    const media = await handler(new Request(base, { method: "POST", headers, body: "{}" }));
    expect(media.status).toBe(415);
    const large = await handler(new Request(base, {
      method: "POST", headers: { ...headers, "content-type": "application/json", "content-length": "99999" }, body: "{}"
    }));
    expect(large.status).toBe(413);
    const streamedLarge = await handler(new Request(base, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "x".repeat(5000)
    }));
    expect(streamedLarge.status).toBe(413);
    expect(repository.count("createThread")).toBe(0);
  });

  it("public-profileでBearer tokenを別modeとして受理しない", async () => {
    const { handler } = fixture();
    const response = await handler(new Request(`${origin}/internal/feedback/v2/profiles/public?workspaceId=OPS&resourceKind=record&resourceKey=order-001`, {
      headers: { authorization: "Bearer a.b.c" }
    }));
    expect(response.status).toBe(401);
  });

  it("Connectorがabort通知を無視してもhard deadlineで504を返し、writeを再試行しない", async () => {
    let createCalls = 0;
    const repository = createFakeFeedbackRepository({
      async getCapabilities() { return capabilities; },
      async createThread() {
        createCalls += 1;
        return new Promise(() => undefined);
      }
    });
    const { handler } = fixture(repository, 100);
    const participant = await issueFeedbackParticipantCredential({
      profile, browserProfileId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5304", origin, secretResolver
    });
    const response = await handler(new Request(`${origin}/internal/feedback/v2/profiles/public/workspaces/OPS/threads`, {
      method: "POST",
      headers: {
        "content-type": "application/json", origin, "x-feedback-csrf": "1",
        "x-feedback-participant-credential": participant.credential
      },
      body: JSON.stringify({
        intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5305", requestHash: `sha256:${"2".repeat(64)}`,
        threadId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5306", resource, title: "timeout", body: "body"
      })
    }));
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ code: "feedback.provider_timeout", retryable: true });
    expect(createCalls).toBe(1);
  });

  it("v1 Connectorのstatus付きlegacy codeを凍結v2 wire codeへ正規化する", async () => {
    const repository = createFakeFeedbackRepository({
      async getCapabilities() {
        throw new FeedbackConnectorProblem({
          code: "feedback.unsupported", status: 413, retryable: false, message: "legacy code"
        });
      }
    });
    const { handler } = fixture(repository);
    const response = await handler(new Request(`${origin}/internal/feedback/v2/profiles/public?workspaceId=OPS&resourceKind=record&resourceKey=order-001`));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "feedback.payload_too_large", retryable: false });
  });
});
