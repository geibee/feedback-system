import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import {
  RedmineTrustedClient
} from "@feedback/redmine-core/trusted";
import { canonicalJson, sha256Hex } from "@feedback/redmine-core";
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
  const client = new RedmineTrustedClient({
    profile,
    apiKey: seed.apiKey,
    fetch: async (url, init) => {
      if (new URL(url).pathname.endsWith("/users/current.json") && currentUserAttempts++ < 2) {
        return new Response(null, { status: 503 });
      }
      return globalThis.fetch(url, init);
    },
    allowHttpDevelopment: true
  });
  const validation = await client.validateConnection();
  assert.equal(currentUserAttempts, 3);
  assert.equal(validation.user.id, seed.userId);
  assert.equal(validation.projectId, seed.projectId);
  assert.equal(validation.customFields, "not-yet-proven");
  const threadId = crypto.randomUUID();
  const intentId = crypto.randomUUID();
  const screenshot = Uint8Array.from(Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  ));
  const capturedAt = new Date().toISOString();
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
  /** @type {import("@feedback/redmine-core/trusted").TrustedCreateInput} */
  const input = {
    profileId: profile.profileId,
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
    evidence,
    hostResourceKey,
    author: {
      source: "redmine-api-key",
      subjectId: String(validation.user.id),
      displayName: validation.user.name,
      redmineUserId: validation.user.id
    },
    submissionChannel: "extension"
  };
  const created = await client.createThread(input, screenshot);
  assert.equal(created.threadId, threadId);
  assert.equal(created.initialComment, "最初のコメント\n再構築テスト");
  assert.equal(created.attachments.length, 2);

  await updateIssue(created.issueId, { notes: "Redmine reply one" });
  await updateIssue(created.issueId, { status_id: seed.closedStatusId });
  await updateIssue(created.issueId, { notes: "notes and priority", priority_id: seed.highPriorityId });

  writeFileSync(statePath, JSON.stringify({
    threadId,
    issueId: created.issueId,
    hostResourceKey: input.hostResourceKey,
    resourceRef,
    pageKey: input.location.pageKey,
    evidenceSha256: evidence.sha256,
    screenshotByteSize: screenshot.byteLength
  }));
  process.stdout.write(`created Redmine ${seed.version} issue ${created.issueId}\n`);
}

async function verifyFixture() {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const direct = new RedmineTrustedClient({ profile, apiKey: seed.apiKey, fetch: globalThis.fetch, allowHttpDevelopment: true });
  assert.equal((await direct.validateConnection()).customFields, "verified");
  const rebuilt = await direct.getThread({ hostResourceKey: state.hostResourceKey, threadId: state.threadId });
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
  const downloaded = await direct.getAttachment({
    hostResourceKey: state.hostResourceKey,
    threadId: state.threadId,
    attachmentId: primary.id
  });
  assert.equal(downloaded.sha256, state.evidenceSha256);
  assert.equal(downloaded.bytes.byteLength, state.screenshotByteSize);

  /** @type {import("@feedback/redmine-core").RedmineThreadSort[]} */
  const sorts = ["created_desc", "created_asc", "updated_desc"];
  for (const sort of sorts) {
    const listed = await direct.listThreads({
      hostResourceKey: state.hostResourceKey,
      pageKey: state.pageKey,
      sort,
      filter: {},
      offset: 0
    });
    assert.equal(listed.threads[0]?.threadId, state.threadId);
  }

  const gateway = createFeedbackRedmineGatewayHandler({
    host: {
      authenticate: async () => ({ subjectId: "host-user", displayName: "Host User", redmineUserId: null }),
      authorizeProfile: async () => true,
      authorizeResource: async () => ({ resourceKey: state.hostResourceKey }),
      authorizeStoredResource: async ({ storedResourceKey }) => storedResourceKey === state.hostResourceKey,
      verifyCsrf: async () => true
    },
    loadProfile: async () => ({ ...profile, authorizationMode: "resource-scoped", secretRef: "conformance-key" }),
    loadSecret: async () => seed.apiKey,
    fetch: globalThis.fetch,
    allowHttpDevelopment: true
  });
  const gatewayResponse = await gateway(new Request(
    `http://app.example/internal/feedback-redmine/v1/profiles/${profile.profileId}/threads/${state.threadId}` +
      "?resourceKind=record&resourceKey=untrusted-client-value",
    { headers: { Origin: "http://app.example", "Sec-Fetch-Site": "same-origin" } }
  ));
  assert.equal(gatewayResponse.status, 200);
  const gatewayThread = (await gatewayResponse.json()).thread;
  assert.deepEqual(gatewayThread, rebuilt);

  const extensionConformanceModule = "../../../apps/feedback-redmine-extension/dist/conformance.js";
  const { fetchThreadThroughExtension } = await import(extensionConformanceModule);
  const { schemaVersion: _schemaVersion, ...clientProfile } = profile.clientProfile;
  const extensionThread = await fetchThreadThroughExtension({
    profile: {
      ...clientProfile,
      hostOrigins: ["https://inventory.example.invalid"],
      redmineBaseUrl: endpoint,
      projectId: profile.projectId,
      trackerId: profile.trackerId,
      isPrivate: profile.isPrivate,
      defaultPriorityId: profile.defaultPriorityId,
      customFieldIds: profile.customFieldIds,
      showRedmineLink: profile.showRedmineLink
    },
    apiKey: seed.apiKey,
    resourceRef: state.resourceRef,
    threadId: state.threadId,
    fetch: globalThis.fetch
  });
  assert.deepEqual(extensionThread, rebuilt);

  const deniedGateway = createFeedbackRedmineGatewayHandler({
    host: {
      authenticate: async () => ({ subjectId: "host-user", displayName: "Host User", redmineUserId: null }),
      authorizeProfile: async () => true,
      authorizeResource: async () => ({ resourceKey: state.hostResourceKey }),
      authorizeStoredResource: async () => false,
      verifyCsrf: async () => true
    },
    loadProfile: async () => ({ ...profile, authorizationMode: "resource-scoped", secretRef: "conformance-key" }),
    loadSecret: async () => seed.apiKey,
    fetch: globalThis.fetch,
    allowHttpDevelopment: true
  });
  const deniedResponse = await deniedGateway(new Request(
    `http://app.example/internal/feedback-redmine/v1/profiles/${profile.profileId}/threads/${state.threadId}` +
      "?resourceKind=record&resourceKey=known-thread-from-other-resource",
    { headers: { Origin: "http://app.example", "Sec-Fetch-Site": "same-origin" } }
  ));
  assert.equal(deniedResponse.status, 404);
  process.stdout.write(`verified Redmine ${seed.version} reconstruction issue ${state.issueId}\n`);
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
