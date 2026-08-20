import { describe, expect, it, vi } from "vitest";
import type { RedmineFetch } from "@feedback/redmine-core/trusted";
import { createFeedbackRedmineGatewayHandler } from "./handler.js";
import type { GatewayDependencies, GatewayServerProfile } from "./profile.js";

const threadId = "00000000-0000-4000-8000-000000000001";
const profile: GatewayServerProfile = {
  profileId: "inventory-production",
  clientProfile: {
    schemaVersion: "1",
    id: "inventory-production",
    displayName: "Inventory / Production",
    applicationKey: "inventory",
    environmentKey: "production",
    externalWorkspaceKey: "production-review",
    perspectives: [{ code: "ux", label: "UI/UX" }],
    capture: { enabled: true, maximumUploadBytes: 10_485_760, contentTypes: ["image/png", "image/webp"] },
    attachments: { maximumInlinePreviewBytes: 10_485_760, maximumDownloadBytes: 52_428_800 }
  },
  redmineBaseUrl: "https://redmine.example.invalid/redmine",
  projectId: 12,
  trackerId: 4,
  isPrivate: true,
  defaultPriorityId: 2,
  customFieldIds: {
    threadId: 21,
    requestHash: 22,
    applicationKey: 23,
    environmentKey: 24,
    externalWorkspaceKey: 25,
    pageKey: 26,
    hostResourceKey: 27,
    perspectiveCode: 28,
    locator: 29,
    submittedById: 30,
    submittedByName: 31
  },
  showRedmineLink: false,
  authorizationMode: "resource-scoped",
  secretRef: "FEEDBACK_REDMINE_GATEWAY_API_KEY"
};

function issueFixture(id = 123) {
  return {
    id,
    subject: "[ux] comment",
    description: "comment",
    status: { id: 1, name: "新規" },
    priority: { id: 2, name: "通常" },
    author: { id: 7, name: "Integration" },
    tracker: { id: 4, name: "Feedback" },
    created_on: "2026-08-19T00:00:00Z",
    updated_on: "2026-08-19T00:00:00Z",
    custom_fields: [
      { id: 21, value: threadId },
      { id: 22, value: "a".repeat(64) },
      { id: 23, value: "inventory" },
      { id: 24, value: "production" },
      { id: 25, value: "production-review" },
      { id: 26, value: "orders.detail" },
      { id: 27, value: "order-1" },
      { id: 28, value: "ux" },
      { id: 29, value: "" },
      { id: 30, value: "00000000-0000-4000-8000-000000000007" },
      { id: 31, value: "利用者" }
    ],
    attachments: [],
    journals: []
  };
}

function dependencies(options: {
  fetch?: RedmineFetch;
  loadProfile?: GatewayDependencies["loadProfile"];
  loadSecret?: GatewayDependencies["loadSecret"];
} = {}) {
  const redmineFetch = options.fetch ?? vi.fn<RedmineFetch>().mockResolvedValue(json({ issues: [], total_count: 0, offset: 0, limit: 100 }));
  const loadProfile = options.loadProfile ?? vi.fn().mockResolvedValue(profile);
  const loadSecret = options.loadSecret ?? vi.fn().mockResolvedValue("server-side-test-key");
  const value: GatewayDependencies = {
    participantSigningKey: "participant-signing-test-secret-at-least-32-bytes",
    fetch: redmineFetch,
    loadProfile,
    loadSecret
  };
  return { value, redmineFetch, loadProfile, loadSecret };
}

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://app.example${path}`, {
    ...init,
    headers: {
      Origin: "https://app.example",
      "Sec-Fetch-Site": "same-origin",
      ...Object.fromEntries(new Headers(init.headers))
    }
  });
}

const listPath = "/internal/feedback-redmine/v1/profiles/inventory-production/threads" +
  "?resourceKind=record&resourceKey=order-1&pageKey=orders.detail&sort=updated_desc";
const detailPath = `/internal/feedback-redmine/v1/profiles/inventory-production/threads/${threadId}` +
  "?resourceKind=record&resourceKey=order-1";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" }
});

async function participantCredential(handler: ReturnType<typeof createFeedbackRedmineGatewayHandler>): Promise<string> {
  const response = await handler(request(
    "/internal/feedback-redmine/v1/profiles/inventory-production/participants",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browserProfileId: "00000000-0000-4000-8000-000000000007" })
    }
  ));
  expect(response.status).toBe(201);
  return (await response.json() as { credential: string }).credential;
}

describe("gateway authentication・same-origin", () => {
  it.each([
    [{ Origin: "https://evil.example", "Sec-Fetch-Site": "same-origin" }, "Origin"],
    [{ Origin: "https://app.example", "Sec-Fetch-Site": "cross-site" }, "Sec-Fetch-Site"]
  ])("Origin/Fetch Metadata不一致を認証前に拒否する", async (headers) => {
    const deps = dependencies();
    const response = await createFeedbackRedmineGatewayHandler(deps.value)(new Request(`https://app.example${listPath}`, { headers }));
    expect(response.status).toBe(403);
    expect(deps.loadProfile).not.toHaveBeenCalled();
    expect(deps.redmineFetch).not.toHaveBeenCalled();
  });

  it("browserがOriginを省略するsame-origin GETを許可し、POSTの省略は拒否する", async () => {
    const deps = dependencies();
    const read = await createFeedbackRedmineGatewayHandler(deps.value)(new Request(
      `https://app.example${listPath}`,
      { headers: { "Sec-Fetch-Site": "same-origin" } }
    ));
    expect(read.status).toBe(200);

    const create = await createFeedbackRedmineGatewayHandler(dependencies().value)(new Request(
      "https://app.example/internal/feedback-redmine/v1/profiles/inventory-production/threads",
      { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" } }
    ));
    expect(create.status).toBe(403);
  });

  it("profile responseにCORS/API key/Redmine内部設定を返さない", async () => {
    const deps = dependencies();
    const response = await createFeedbackRedmineGatewayHandler(deps.value)(request(
      "/internal/feedback-redmine/v1/profiles/inventory-production"
    ));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("server-side-test-key");
    expect(body).not.toContain("redmineBaseUrl");
    expect(body).not.toContain("projectId");
  });
});

describe("public participant mode", () => {
  it("host sessionなしでparticipantを発行しprofile/me capabilityを返す", async () => {
    const deps = dependencies();
    const handler = createFeedbackRedmineGatewayHandler(deps.value);
    const participantId = "00000000-0000-4000-8000-000000000007";
    const issuedResponse = await handler(request(
      "/internal/feedback-redmine/v1/profiles/inventory-production/participants",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ browserProfileId: participantId })
      }
    ));
    expect(issuedResponse.status).toBe(201);
    expect(issuedResponse.headers.get("cache-control")).toBe("no-store");
    const issued = await issuedResponse.json() as { participantId: string; credential: string };
    expect(issued.participantId).not.toBe(participantId);
    expect(issued.participantId).toMatch(/^[0-9a-f-]{36}$/u);

    const profileResponse = await handler(request("/internal/feedback-redmine/v1/profiles/inventory-production"));
    expect(await profileResponse.json()).toMatchObject({
      capabilities: { canRead: true, canCreate: true, canReply: true, canEditOwn: true, stateReadOnly: true }
    });
    const meResponse = await handler(request("/internal/feedback-redmine/v1/profiles/inventory-production/me", {
      headers: { "X-Feedback-Participant-Credential": issued.credential }
    }));
    expect(await meResponse.json()).toEqual({
      principal: { participantId: issued.participantId, displayName: null, source: "participant-credential" }
    });
    const tampered = await handler(request("/internal/feedback-redmine/v1/profiles/inventory-production/me", {
      headers: { "X-Feedback-Participant-Credential": `${issued.credential.slice(0, -1)}x` }
    }));
    expect(tampered.status).toBe(403);
  });
});

describe("gateway resource authorization・IDOR", () => {
  it("unknown queryをRedmine fetch前に止める", async () => {
    const deps = dependencies();
    const unknown = await createFeedbackRedmineGatewayHandler(deps.value)(request(`${listPath}&url=https://evil.invalid`));
    expect(unknown.status).toBe(400);
    expect(deps.redmineFetch).not.toHaveBeenCalled();
  });

  it("workspace scopeではProfile境界だけをRedmineへ渡して総件数を返す", async () => {
    const redmineFetch = vi.fn<RedmineFetch>(async (url) => {
      const query = new URL(url).searchParams;
      expect(query.get("cf_23")).toBe("inventory");
      expect(query.get("cf_24")).toBe("production");
      expect(query.get("cf_25")).toBe("production-review");
      expect(query.has("cf_26")).toBe(false);
      expect(query.has("cf_27")).toBe(false);
      return json({ issues: [issueFixture()], total_count: 1, offset: 0, limit: 100 });
    });
    const response = await createFeedbackRedmineGatewayHandler(dependencies({ fetch: redmineFetch }).value)(request(
      "/internal/feedback-redmine/v1/profiles/inventory-production/threads?scope=workspace&sort=updated_desc"
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ totalCount: 1, nextCursor: null });
  });

  it("workspace scopeへのresource条件をRedmine接続前に拒否する", async () => {
    const deps = dependencies();
    const response = await createFeedbackRedmineGatewayHandler(deps.value)(request(
      "/internal/feedback-redmine/v1/profiles/inventory-production/threads" +
      "?scope=workspace&resourceKind=record&resourceKey=order-1&pageKey=orders.detail&sort=updated_desc"
    ));
    expect(response.status).toBe(400);
    expect(deps.redmineFetch).not.toHaveBeenCalled();
  });

  it("requestのresource keyが保存済みkeyと異なる場合は404にする", async () => {
    const redmineFetch = vi.fn<RedmineFetch>(async (url) => {
      expect(new URL(url).pathname).toBe("/redmine/issues.json");
      return json({ issues: [issueFixture()], total_count: 1, offset: 0, limit: 100 });
    });
    const deps = dependencies({ fetch: redmineFetch });
    const response = await createFeedbackRedmineGatewayHandler(deps.value)(request(
      detailPath.replace("resourceKey=order-1", "resourceKey=another-order")
    ));
    expect(response.status).toBe(404);
    expect(redmineFetch).toHaveBeenCalledTimes(1);
  });

  it("他threadのattachment IDをmetadata取得前に404にする", async () => {
    const redmineFetch = vi.fn<RedmineFetch>(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/issues.json")) {
        return json({ issues: [issueFixture()], total_count: 1, offset: 0, limit: 100 });
      }
      if (parsed.pathname.endsWith("/issues/123.json")) return json({ issue: issueFixture() });
      throw new Error(`attachment metadataへ到達しました: ${url}`);
    });
    const deps = dependencies({ fetch: redmineFetch });
    const path = `/internal/feedback-redmine/v1/profiles/inventory-production/threads/${threadId}/attachments/999` +
      "?resourceKind=record&resourceKey=order-1";
    const response = await createFeedbackRedmineGatewayHandler(deps.value)(request(path));
    expect(response.status).toBe(404);
    expect(redmineFetch.mock.calls.some(([url]) => new URL(url).pathname.includes("/attachments/"))).toBe(false);
  });
});

describe("gateway create protection", () => {
  function createForm(extra: Record<string, unknown> = {}) {
    const form = new FormData();
    form.append("request", new Blob([JSON.stringify({
      resourceRef: { schemaVersion: "1", kind: "record", key: "order-1" },
      threadId,
      intentId: "00000000-0000-4000-8000-000000000002",
      comment: "comment",
      perspectiveCode: "ux",
      location: {
        schemaVersion: "1",
        pageKey: "orders.detail",
        routeTemplate: "/orders/{orderId}",
        pathParameters: { orderId: "sha256:value" }
      },
      target: { schemaVersion: "1", kind: "screen-position", relativeX: 0.5, relativeY: 0.5 },
      release: "2026.08.19",
      locale: "ja-JP",
      threadUrl: `https://app.example/orders/value?feedbackThread=${threadId}`,
      capturedAt: "2026-08-19T00:00:00Z",
      evidence: null,
      ...extra
    })], { type: "application/json" }));
    return form;
  }

  it("participant credential欠落とclient指定author/projectをRedmine接続前に拒否する", async () => {
    const createPath = "/internal/feedback-redmine/v1/profiles/inventory-production/threads";
    const deps = dependencies();
    const handler = createFeedbackRedmineGatewayHandler(deps.value);
    const missing = await handler(request(createPath, {
      method: "POST",
      headers: { "Idempotency-Key": "00000000-0000-4000-8000-000000000002" },
      body: createForm()
    }));
    expect(missing.status).toBe(403);
    expect(deps.redmineFetch).not.toHaveBeenCalled();

    const credential = await participantCredential(handler);
    const invalidBody = await handler(request(createPath, {
      method: "POST",
      headers: {
        "X-Feedback-Participant-Credential": credential,
        "Idempotency-Key": "00000000-0000-4000-8000-000000000002"
      },
      body: createForm({ author: { subjectId: "attacker" }, projectId: 999 })
    }));
    expect(invalidBody.status).toBe(400);
  });

  it("unknown multipart partを拒否する", async () => {
    const form = createForm();
    form.append("url", "https://evil.invalid");
    const deps = dependencies();
    const handler = createFeedbackRedmineGatewayHandler(deps.value);
    const credential = await participantCredential(handler);
    const response = await handler(request(
      "/internal/feedback-redmine/v1/profiles/inventory-production/threads",
      {
        method: "POST",
        headers: {
          "X-Feedback-Participant-Credential": credential,
          "Idempotency-Key": "00000000-0000-4000-8000-000000000002"
        },
        body: form
      }
    ));
    expect(response.status).toBe(400);
    expect(deps.redmineFetch).not.toHaveBeenCalled();
  });

  it("thread URLは同一originかつ対象threadだけを許可する", async () => {
    const createPath = "/internal/feedback-redmine/v1/profiles/inventory-production/threads";
    const deps = dependencies();
    const handler = createFeedbackRedmineGatewayHandler(deps.value);
    const credential = await participantCredential(handler);
    for (const threadUrl of [
      `https://evil.example/orders/1?feedbackThread=${threadId}`,
      "https://app.example/orders/1?feedbackThread=00000000-0000-4000-8000-000000000099"
    ]) {
      const response = await handler(request(createPath, {
        method: "POST",
        headers: {
          "X-Feedback-Participant-Credential": credential,
          "Idempotency-Key": "00000000-0000-4000-8000-000000000002"
        },
        body: createForm({ threadUrl })
      }));
      expect(response.status).toBe(400);
    }
    expect(deps.redmineFetch).not.toHaveBeenCalled();
  });

  it("evidence filenameのthread ID不一致をRedmine接続前に拒否する", async () => {
    const form = createForm({
      evidence: {
        filename: "feedback-00000000-0000-4000-8000-000000000099.png",
        contentType: "image/png",
        byteSize: 4,
        sha256: "a".repeat(64),
        viewportWidth: 1,
        viewportHeight: 1,
        pixelRatio: 1,
        capturedAt: "2026-08-19T00:00:00Z"
      }
    });
    const deps = dependencies();
    const handler = createFeedbackRedmineGatewayHandler(deps.value);
    const credential = await participantCredential(handler);
    const response = await handler(request(
      "/internal/feedback-redmine/v1/profiles/inventory-production/threads",
      {
        method: "POST",
        headers: {
          "X-Feedback-Participant-Credential": credential,
          "Idempotency-Key": "00000000-0000-4000-8000-000000000002"
        },
        body: form
      }
    ));
    expect(response.status).toBe(400);
    expect(deps.redmineFetch).not.toHaveBeenCalled();
  });

  it("新規作成を201、同じintentの回収を200で返す", async () => {
    let createdIssue: ReturnType<typeof issueFixture> | null = null;
    const redmineFetch = vi.fn<RedmineFetch>(async (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/uploads.json")) {
        return json({ upload: { token: "context-upload-token" } }, 201);
      }
      if (parsed.pathname.endsWith("/issues.json") && init.method === "POST") {
        const requestBody = JSON.parse(init.body as string) as {
          issue: { subject: string; description: string; custom_fields: Array<{ id: number; value: string }> };
        };
        createdIssue = {
          ...issueFixture(),
          subject: requestBody.issue.subject,
          description: requestBody.issue.description,
          custom_fields: requestBody.issue.custom_fields
        };
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
      if (parsed.pathname.endsWith("/issues/123.json") && createdIssue) {
        return json({ issue: createdIssue });
      }
      throw new Error(`unexpected request: ${init.method} ${url}`);
    });
    const deps = dependencies({ fetch: redmineFetch });
    const handler = createFeedbackRedmineGatewayHandler(deps.value);
    const credential = await participantCredential(handler);
    const createPath = "/internal/feedback-redmine/v1/profiles/inventory-production/threads";
    const createRequest = () => request(createPath, {
      method: "POST",
      headers: {
        "X-Feedback-Participant-Credential": credential,
        "Idempotency-Key": "00000000-0000-4000-8000-000000000002"
      },
      body: createForm()
    });

    expect((await handler(createRequest())).status).toBe(201);
    expect((await handler(createRequest())).status).toBe(200);
    expect(redmineFetch.mock.calls.filter(([url, init]) =>
      init.method === "POST" && new URL(url).pathname.endsWith("/issues.json")
    )).toHaveLength(1);
  });
});
