import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import {
  parseThreadListResult,
  parseThreadResult,
  sha256Hex
} from "@geibee/redmine-core";
import { createFeedbackRedmineGatewayHandler } from "@geibee/redmine-gateway";

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
  const threadId = crypto.randomUUID();
  const intentId = crypto.randomUUID();
  const screenshot = Uint8Array.from(Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  ));
  const capturedAt = new Date().toISOString();
  /** @type {import("@geibee/redmine-core").FeedbackHostResourceRefV1} */
  const resourceRef = { schemaVersion: "1", kind: "record", key: "conformance-resource" };
  const hostResourceKey = resourceRef.key;
  /** @type {NonNullable<import("@geibee/redmine-core").RedmineThreadCreateInput["evidence"]>} */
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
  const gateway = gatewayHandler();
  const credential = await issueCredential(gateway);
  const currentUserResponse = await gateway(gatewayRequest(`${profilePath()}/me`, {
    headers: { "X-Feedback-Participant-Credential": credential }
  }));
  assert.equal(currentUserResponse.status, 200, await currentUserResponse.clone().text());

  /** @type {import("@geibee/redmine-core").RedmineThreadCreateInput} */
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
    threadUrl: `http://app.example/orders/conformance?feedbackThread=${threadId}`,
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
      "X-Feedback-Participant-Credential": credential,
      "Idempotency-Key": intentId
    },
    body: form
  }));
  assert.equal(createResponse.status, 201, await createResponse.clone().text());
  const created = parseThreadResult(await createResponse.json());
  assert.equal(created.threadId, threadId);
  assert.equal(created.initialComment, "最初のコメント\n再構築テスト");
  assert.equal(created.attachments.length, 2);

  const initialEditIntentId = crypto.randomUUID();
  const initialEditResponse = await gateway(gatewayRequest(`${profilePath()}/threads/${threadId}/messages/${threadId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Feedback-Participant-Credential": credential,
      "Idempotency-Key": initialEditIntentId
    },
    body: JSON.stringify({
      body: "最初のコメント\n再構築テスト（編集済み）",
      participantName: "Conformance participant",
      expectedVersion: 1
    })
  }));
  assert.equal(initialEditResponse.status, 200, await initialEditResponse.clone().text());
  const initialEdited = parseThreadResult(await initialEditResponse.json());
  assert.equal(initialEdited.initialComment, "最初のコメント\n再構築テスト（編集済み）");
  const rawDescription = (await issueDescription(created.issueId)).replace(/\r\n?/gu, "\n");
  assert.equal(rawDescription,
    `最初のコメント\n再構築テスト（編集済み）\n\n---\nアプリでこのフィードバックを開く\n${input.threadUrl}`);
  assert(!rawDescription.includes("Feedback metadata v1"));
  assert(!rawDescription.includes("Application:"));

  const messageId = crypto.randomUUID();
  const replyIntentId = crypto.randomUUID();
  const replyResponse = await gateway(gatewayRequest(`${profilePath()}/threads/${threadId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Feedback-Participant-Credential": credential,
      "Idempotency-Key": replyIntentId
    },
    body: JSON.stringify({ messageId, body: "Feedback UI reply original", participantName: "Conformance participant" })
  }));
  assert.equal(replyResponse.status, 201, await replyResponse.clone().text());

  const editIntentId = crypto.randomUUID();
  const editResponse = await gateway(gatewayRequest(`${profilePath()}/threads/${threadId}/messages/${messageId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Feedback-Participant-Credential": credential,
      "Idempotency-Key": editIntentId
    },
    body: JSON.stringify({ body: "Feedback UI reply edited", participantName: "Conformance participant", expectedVersion: 1 })
  }));
  assert.equal(editResponse.status, 200, await editResponse.clone().text());
  const edited = parseThreadResult(await editResponse.json());
  const editedMessage = edited.messages?.find((message) => message.id === messageId);
  assert.equal(editedMessage?.body, "Feedback UI reply edited");
  assert.deepEqual(editedMessage?.versions.map((version) => version.body), [
    "Feedback UI reply original",
    "Feedback UI reply edited"
  ]);

  await updateIssue(created.issueId, { notes: "Redmine reply one" });
  await updateIssue(created.issueId, { status_id: seed.closedStatusId });
  await updateIssue(created.issueId, { notes: "notes and priority", priority_id: seed.highPriorityId });

  writeFileSync(statePath, JSON.stringify({
    threadId,
    issueId: created.issueId,
    messageId,
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
  const gateway = gatewayHandler();
  const credential = await issueCredential(gateway);
  const currentUserResponse = await gateway(gatewayRequest(`${profilePath()}/me`, {
    headers: { "X-Feedback-Participant-Credential": credential }
  }));
  assert.equal(currentUserResponse.status, 200, await currentUserResponse.clone().text());
  const detailResponse = await gateway(gatewayRequest(
    `${profilePath()}/threads/${state.threadId}?resourceKind=record&resourceKey=${state.resourceRef.key}`,
    { headers: { "X-Feedback-Participant-Credential": credential } }
  ));
  assert.equal(detailResponse.status, 200, await detailResponse.clone().text());
  const rebuilt = parseThreadResult(await detailResponse.json());
  assert.equal(rebuilt.threadId, state.threadId);
  assert.equal(rebuilt.initialComment, "最初のコメント\n再構築テスト（編集済み）");
  assert(rebuilt.locator);
  assert.equal(rebuilt.locator.location.pageKey, state.pageKey);
  assert.equal(rebuilt.diagnosticCount, 0);
  const replies = rebuilt.timeline.filter((item) => item.kind === "reply");
  const activities = rebuilt.timeline.filter((item) => item.kind === "activity");
  assert(replies.some((item) => item.body === "Redmine reply one"));
  assert(replies.some((item) => item.body === "notes and priority"));
  assert(replies.some((item) => item.body === "edited reply current"));
  assert(!replies.some((item) => item.body === "edited reply original" || !item.body.trim()));
  const feedbackReply = rebuilt.messages?.find((message) => message.id === state.messageId);
  assert.equal(feedbackReply?.body, "Feedback UI reply edited");
  assert.equal(feedbackReply?.version, 2);
  assert(activities.some((item) => item.field === "status"));
  assert(activities.some((item) => item.field === "priority"));
  assert(activities.some((item) => item.field === "subject"));
  assert(replies.some((reply) => activities.some((activity) => activity.journalId === reply.journalId)));
  assert.equal(rebuilt.attachments.length, 2);
  const primary = rebuilt.attachments.find((attachment) => attachment.primaryEvidence);
  assert(primary);
  const attachmentResponse = await gateway(gatewayRequest(
    `${profilePath()}/threads/${state.threadId}/attachments/${primary.id}` +
      `?resourceKind=record&resourceKey=${state.resourceRef.key}`
  ));
  assert.equal(attachmentResponse.status, 200, await attachmentResponse.clone().text());
  const downloaded = new Uint8Array(await attachmentResponse.arrayBuffer());
  assert.equal(attachmentResponse.headers.get("x-feedback-content-sha256"), state.evidenceSha256);
  assert.equal(await sha256Hex(downloaded), state.evidenceSha256);
  assert.equal(downloaded.byteLength, state.screenshotByteSize);

  /** @type {import("@geibee/redmine-core").RedmineThreadSort[]} */
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

  const deniedResponse = await gateway(gatewayRequest(
    `${profilePath()}/threads/${state.threadId}?resourceKind=record&resourceKey=known-thread-from-other-resource`
  ));
  assert.equal(deniedResponse.status, 404);
  process.stdout.write(`verified Redmine ${seed.version} reconstruction issue ${state.issueId}\n`);
}

function profilePath() {
  return `/internal/feedback-redmine/v1/profiles/${profile.profileId}`;
}

/**
 * @param {import("@geibee/redmine-core/trusted").RedmineFetch} [redmineFetch]
 */
function gatewayHandler(redmineFetch = globalThis.fetch) {
  return createFeedbackRedmineGatewayHandler({
    participantSigningKey: "redmine-conformance-participant-signing-key-v1",
    loadProfile: async () => ({ ...profile, authorizationMode: "resource-scoped", secretRef: "conformance-key" }),
    loadSecret: async () => seed.apiKey,
    fetch: redmineFetch,
    allowHttpDevelopment: true
  });
}

/**
 * @param {ReturnType<typeof createFeedbackRedmineGatewayHandler>} gateway
 */
async function issueCredential(gateway) {
  const response = await gateway(gatewayRequest(`${profilePath()}/participants`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ browserProfileId: "00000000-0000-4000-8000-000000000007" })
  }));
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).credential;
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

/** @param {number} issueId */
async function issueDescription(issueId) {
  const response = await fetch(`${endpoint}/issues/${issueId}.json`, {
    headers: { "X-Redmine-API-Key": seed.apiKey }
  });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).issue.description;
}

/**
 * @param {string} baseUrl
 * @param {any} fixture
 * @returns {import("@geibee/redmine-core/trusted").RedmineConnectorProfile}
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
    showRedmineLink: false,
    closedStatusIds: [fixture.closedStatusId]
  };
}
