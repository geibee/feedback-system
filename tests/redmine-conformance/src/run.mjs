import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import {
  canonicalJson,
  parseThreadListResult,
  parseThreadResult,
  sha256Hex
} from "@feedback/redmine-core";
import { createFeedbackRedmineGatewayHandler } from "@feedback/redmine-gateway";

const [commandArg, endpointArg, seedPathArg, statePathArg] = process.argv.slice(2);
if (!commandArg || !endpointArg || !seedPathArg || !statePathArg) throw new Error("command/endpoint/seed path/state pathは必須です");
const command = commandArg;
const endpoint = endpointArg;
const seedPath = seedPathArg;
const statePath = statePathArg;
const seedText = readFileSync(seedPath, "utf8").trim().split("\n").at(-1);
if (!seedText) throw new Error("Redmine seed結果が空です");
const seed = JSON.parse(seedText);
const profile = connectorProfile(endpoint, seed);

if (command === "create") await createFixture();
else if (command === "verify") await verifyFixture();
else throw new Error(`unknown command: ${command}`);

async function createFixture() {
  let currentUserAttempts = 0;
  /** @type {import("@feedback/redmine-core/trusted").RedmineFetch} */
  const retryingFetch = async (url, init) => {
    if (new URL(url).pathname.endsWith("/users/current.json") && currentUserAttempts++ < 2) {
      return new Response(null, { status: 503 });
    }
    return globalThis.fetch(url, init);
  };
  const threadId = crypto.randomUUID();
  const intentId = crypto.randomUUID();
  const screenshot = Uint8Array.from(Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  ));
  const capturedAt = new Date().toISOString();
  /** @type {import("@feedback/redmine-core").FeedbackHostResourceRefV1} */
  const resourceRef = { schemaVersion: "1", kind: "record", key: "conformance-resource" };
  const hostResourceKey = await sha256Hex(new TextEncoder().encode(canonicalJson(resourceRef)));
  /** @type {NonNullable<import("@feedback/redmine-core").RedmineThreadCreateInput["evidence"]>} */
  const evidence = {
    filename: `feedback-${threadId}.png`,
    contentType: "image/png",
    byteSize: screenshot.byteLength,
    sha256: await sha256Hex(screenshot),
    viewportWidth: 1,
    viewportHeight: 1,
    pixelRatio: 1,
    capturedAt
  };
  const gateway = gatewayHandler(hostResourceKey, retryingFetch);
  const currentUserResponse = await gateway(gatewayRequest(`${profilePath()}/me`));
  assert.equal(currentUserResponse.status, 200, await currentUserResponse.clone().text());
  assert.equal(currentUserAttempts, 3);

  /** @type {import("@feedback/redmine-core").RedmineThreadCreateInput} */
  const input = {
    profileId: profile.profileId,
    resourceRef,
    threadId,
    intentId,
    comment: "最初のコメント\n再構築テスト",
    perspectiveCode: "ux",
    location: {
      schemaVersion: "1",
      pageKey: "orders.detail",
      routeTemplate: "/orders/{orderId}",
      pathParameters: { orderId: "sha256:conformance" },
      queryParameters: {}
    },
    target: { schemaVersion: "1", kind: "screen-position", relativeX: 0.5, relativeY: 0.5 },
    release: "conformance",
    locale: "ja-JP",
    capturedAt,
    evidence
  };
  const form = new FormData();
  const { profileId: _profileId, ...createRequest } = input;
  form.append("request", new Blob([JSON.stringify(createRequest)], { type: "application/json;charset=utf-8" }));
  form.append("evidence", new Blob([screenshot], { type: evidence.contentType }), evidence.filename);
  const createResponse = await gateway(gatewayRequest(`${profilePath()}/threads`, {
    method: "POST",
    headers: {
      "X-Feedback-CSRF": "conformance-csrf",
      "Idempotency-Key": intentId
    },
    body: form
  }));
  assert.equal(createResponse.status, 201, await createResponse.clone().text());
  const created = parseThreadResult(await createResponse.json());
  assert.equal(created.threadId, threadId);
  assert.equal(created.initialComment, "最初のコメント\n再構築テスト");
  assert.equal(created.attachments.length, 2);

  await updateIssue(created.issueId, { notes: "Redmine reply one" });
  await updateIssue(created.issueId, { status_id: seed.closedStatusId });
  await updateIssue(created.issueId, { notes: "notes and priority", priority_id: seed.highPriorityId });

  writeFileSync(statePath, JSON.stringify({
    threadId,
    issueId: created.issueId,
    hostResourceKey,
    resourceRef,
    pageKey: input.location.pageKey,
    evidenceSha256: evidence.sha256,
    screenshotByteSize: screenshot.byteLength
  }));
  process.stdout.write(`created Redmine ${seed.version} issue ${created.issueId}\n`);
}

async function verifyFixture() {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const gateway = gatewayHandler(state.hostResourceKey);
  const currentUserResponse = await gateway(gatewayRequest(`${profilePath()}/me`));
  assert.equal(currentUserResponse.status, 200, await currentUserResponse.clone().text());
  const detailResponse = await gateway(gatewayRequest(
    `${profilePath()}/threads/${state.threadId}?resourceKind=record&resourceKey=untrusted-client-value`
  ));
  assert.equal(detailResponse.status, 200, await detailResponse.clone().text());
  const rebuilt = parseThreadResult(await detailResponse.json());
  assert.equal(rebuilt.threadId, state.threadId);
  assert.equal(rebuilt.initialComment, "最初のコメント\n再構築テスト");
  assert(rebuilt.locator);
  assert.equal(rebuilt.locator.location.pageKey, state.pageKey);
  assert.equal(rebuilt.diagnosticCount, 0);
  const replies = rebuilt.timeline.filter((item) => item.kind === "reply");
  const activities = rebuilt.timeline.filter((item) => item.kind === "activity");
  assert(replies.some((item) => item.body === "Redmine reply one"));
  assert(replies.some((item) => item.body === "notes and priority"));
  assert(replies.some((item) => item.body === "edited reply current"));
  assert(!replies.some((item) => item.body === "edited reply original" || !item.body.trim()));
  assert(activities.some((item) => item.field === "status"));
  assert(activities.some((item) => item.field === "priority"));
  assert(activities.some((item) => item.field === "subject"));
  assert(replies.some((reply) => activities.some((activity) => activity.journalId === reply.journalId)));
  assert.equal(rebuilt.attachments.length, 2);
  const primary = rebuilt.attachments.find((attachment) => attachment.primaryEvidence);
  assert(primary);
  const attachmentResponse = await gateway(gatewayRequest(
    `${profilePath()}/threads/${state.threadId}/attachments/${primary.id}` +
      "?resourceKind=record&resourceKey=untrusted-client-value"
  ));
  assert.equal(attachmentResponse.status, 200, await attachmentResponse.clone().text());
  const downloaded = new Uint8Array(await attachmentResponse.arrayBuffer());
  assert.equal(attachmentResponse.headers.get("x-feedback-content-sha256"), state.evidenceSha256);
  assert.equal(await sha256Hex(downloaded), state.evidenceSha256);
  assert.equal(downloaded.byteLength, state.screenshotByteSize);

  /** @type {import("@feedback/redmine-core").RedmineThreadSort[]} */
  const sorts = ["created_desc", "created_asc", "updated_desc"];
  for (const sort of sorts) {
    const query = new URLSearchParams({
      resourceKind: state.resourceRef.kind,
      resourceKey: state.resourceRef.key,
      pageKey: state.pageKey,
      sort
    });
    const listResponse = await gateway(gatewayRequest(`${profilePath()}/threads?${query}`));
    assert.equal(listResponse.status, 200, await listResponse.clone().text());
    const listed = parseThreadListResult(await listResponse.json());
    assert.equal(listed.threads[0]?.threadId, state.threadId);
  }

  const deniedGateway = gatewayHandler(state.hostResourceKey, globalThis.fetch, false);
  const deniedResponse = await deniedGateway(gatewayRequest(
    `${profilePath()}/threads/${state.threadId}?resourceKind=record&resourceKey=known-thread-from-other-resource`
  ));
  assert.equal(deniedResponse.status, 404);
  process.stdout.write(`verified Redmine ${seed.version} reconstruction issue ${state.issueId}\n`);
}

function profilePath() {
  return `/internal/feedback-redmine/v1/profiles/${profile.profileId}`;
}

/**
 * @param {string} hostResourceKey
 * @param {import("@feedback/redmine-core/trusted").RedmineFetch} [redmineFetch]
 * @param {boolean} [allowStoredResource]
 */
function gatewayHandler(hostResourceKey, redmineFetch = globalThis.fetch, allowStoredResource = true) {
  return createFeedbackRedmineGatewayHandler({
    host: {
      authenticate: async () => ({
        subjectId: "conformance-host-user",
        displayName: "Conformance Host User",
        redmineUserId: seed.userId
      }),
      authorizeProfile: async () => true,
      authorizeResource: async () => ({ resourceKey: hostResourceKey }),
      authorizeStoredResource: async ({ storedResourceKey }) =>
        allowStoredResource && storedResourceKey === hostResourceKey,
      verifyCsrf: async () => true
    },
    loadProfile: async () => ({ ...profile, authorizationMode: "resource-scoped", secretRef: "conformance-key" }),
    loadSecret: async () => seed.apiKey,
    fetch: redmineFetch,
    allowHttpDevelopment: true
  });
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
function gatewayRequest(path, init = {}) {
  return new Request(`http://app.example${path}`, {
    ...init,
    headers: {
      Origin: "http://app.example",
      "Sec-Fetch-Site": "same-origin",
      ...Object.fromEntries(new Headers(init.headers))
    }
  });
}

/**
 * @param {number} issueId
 * @param {Record<string, string | number>} issue
 */
async function updateIssue(issueId, issue) {
  const response = await fetch(`${endpoint}/issues/${issueId}.json`, {
    method: "PUT",
    redirect: "error",
    headers: { "Content-Type": "application/json", "X-Redmine-API-Key": seed.apiKey },
    body: JSON.stringify({ issue })
  });
  assert.equal(response.status, 204, await response.text());
}

/**
 * @param {string} baseUrl
 * @param {any} fixture
 * @returns {import("@feedback/redmine-core/trusted").RedmineConnectorProfile}
 */
function connectorProfile(baseUrl, fixture) {
  return {
    profileId: "redmine-conformance",
    clientProfile: {
      schemaVersion: "1",
      id: "redmine-conformance",
      displayName: "Redmine Conformance",
      applicationKey: "inventory",
      environmentKey: "test",
      externalWorkspaceKey: "docker-matrix",
      perspectives: [{ code: "ux", label: "UI/UX" }],
      capture: { enabled: true, maximumUploadBytes: 1_048_576, contentTypes: ["image/png", "image/webp"] },
      attachments: { maximumInlinePreviewBytes: 1_048_576, maximumDownloadBytes: 1_048_576 }
    },
    redmineBaseUrl: baseUrl,
    projectId: fixture.projectId,
    trackerId: fixture.trackerId,
    isPrivate: true,
    defaultPriorityId: fixture.normalPriorityId,
    customFieldIds: fixture.customFieldIds,
    showRedmineLink: false
  };
}
