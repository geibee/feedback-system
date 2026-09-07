#!/usr/bin/env node
// Jira Cloud開発siteへrun-owned issueだけを作成し、Connectorのlive acceptance後に削除する。
import { createHash, randomUUID } from "node:crypto";
import {
  createFeedbackJiraCloudConnector,
  createJiraCloudFetchTransport
} from "@geibee/feedback-connector-jira-cloud";
import { calculateFeedbackCommandHash, createFeedbackEnvelopeCodec } from "@geibee/feedback-envelope";
import { feedbackLiveDigest } from "./lib/feedback-live-digest.mjs";
import { trackJiraLiveRepository } from "./lib/feedback-jira-live-ownership.mjs";
import { runFeedbackReferenceAcceptance } from "./lib/feedback-reference-acceptance.mjs";

const siteUrl = origin(required("FEEDBACK_JIRA_ACCEPTANCE_SITE_URL"));
const projectKey = stableKey(required("FEEDBACK_JIRA_ACCEPTANCE_PROJECT_KEY"));
const email = required("FEEDBACK_JIRA_ACCEPTANCE_EMAIL");
const apiToken = required("FEEDBACK_JIRA_ACCEPTANCE_API_TOKEN");
if (process.env.FEEDBACK_JIRA_ACCEPTANCE_CLEANUP_POLICY !== "delete-run-owned") {
  throw new Error("FEEDBACK_JIRA_ACCEPTANCE_CLEANUP_POLICY=delete-run-ownedが必要です");
}
const authorization = `Basic ${Buffer.from(`${email}:${apiToken}`, "utf8").toString("base64")}`;
const issueTypeId = process.env.FEEDBACK_JIRA_ACCEPTANCE_ISSUE_TYPE_ID ?? await discoverIssueType();
const runId = randomUUID();
const threadId = randomUUID();
const createIntentId = randomUUID();
const resource = { kind: "record", key: `phase5-${runId}` };
const scope = {
  profileId: "phase5-jira-live",
  installationId: "managed-development-site",
  workspaceId: projectKey,
  resource
};
const envelopeSecret = crypto.getRandomValues(new Uint8Array(32));
const codec = createFeedbackEnvelopeCodec([{
  kid: "phase5-ephemeral",
  secret: envelopeSecret,
  state: "active"
}]);
const connector = createFeedbackJiraCloudConnector({
  configuration: {
    profileId: scope.profileId,
    installationId: scope.installationId,
    application: "feedback-system",
    environment: "phase5-acceptance",
    participantId: randomUUID(),
    issueTypeId,
    maximumAttachmentBytes: 1024 * 1024,
    attachmentContentTypes: ["text/plain"],
    pageSize: 50,
    recoveryRetryAfterSeconds: 2
  },
  transport: createJiraCloudFetchTransport({
    baseUrl: siteUrl,
    authorization,
    fetch: jiraFetch,
    timeoutMilliseconds: 30_000
  }),
  envelopeCodec: codec
});

let issueId = null;
const issueIds = new Set();
const evidence = {
  schemaVersion: "1",
  kind: "jira-cloud-phase5-live-acceptance",
  contractVersion: "2.0.0-alpha.3",
  implementationDigest: implementationDigest(),
  executedAt: new Date().toISOString(),
  api: "Jira Cloud REST API v3",
  siteType: "Forge development demo",
  tenantIdentifiersRemoved: true,
  runOwnedIssueCreated: false,
  firstWriteTripletRecovered: false,
  commentRoundtrip: false,
  revisionRoundtrip: false,
  bodyIntegrityVerified: false,
  attachmentRoundtrip: false,
  attachmentMessageBindingVerified: false,
  automaticWriteRetry: false,
  cleanup: "not-started"
};

try {
  const createCommand = {
    threadId,
    intentId: createIntentId,
    requestHash: calculateFeedbackCommandHash({ operation: "phase5-create", runId }),
    resource,
    title: `[feedback-phase5:${runId}] Connector live acceptance`,
    body: "Phase 5 managed acceptance issue. cleanup対象。"
  };
  const created = await connector.createThread({ ...scope, command: createCommand });
  if (!("thread" in created) || created.thread.threadId !== threadId) throw new Error("Jira create resultが不正です");
  evidence.runOwnedIssueCreated = true;
  issueId = await waitForUniqueCandidate();
  issueIds.add(issueId);
  const recoveredCreate = await connector.recoverIntent({
    ...scope,
    threadId,
    intentId: createIntentId,
    requestHash: createCommand.requestHash,
    operation: "feedback:create"
  });
  if (recoveredCreate.state !== "completed") throw new Error("Jira create intentをproviderから回収できません");
  evidence.firstWriteTripletRecovered = true;

  const replyIntentId = randomUUID();
  const messageId = randomUUID();
  const replyHash = calculateFeedbackCommandHash({ operation: "phase5-reply", runId });
  const reply = await connector.reply({
    ...scope,
    threadId,
    command: { intentId: replyIntentId, requestHash: replyHash, messageId, body: "Phase 5 reply" }
  });
  if (!("message" in reply) || reply.message.messageId !== messageId) throw new Error("Jira reply resultが不正です");
  evidence.commentRoundtrip = true;

  const revisionIntentId = randomUUID();
  const revisionId = randomUUID();
  const revisionHash = calculateFeedbackCommandHash({ operation: "phase5-revision", runId });
  const revision = await connector.appendRevision({
    ...scope,
    threadId,
    messageId,
    command: {
      intentId: revisionIntentId,
      requestHash: revisionHash,
      revisionId,
      expectedRevisionId: messageId,
      body: "Phase 5 revised reply"
    }
  });
  if (!("message" in revision) || revision.message.body !== "Phase 5 revised reply" ||
      revision.message.revisions.at(-1)?.revisionId !== revisionId) {
    throw new Error("Jira revision resultが不正です");
  }
  evidence.revisionRoundtrip = true;

  const attachmentBytes = new TextEncoder().encode(`feedback phase5 ${runId}\n`);
  const attachmentId = randomUUID();
  const attachmentIntentId = randomUUID();
  const attachmentHash = `sha256:${createHash("sha256").update(attachmentBytes).digest("hex")}`;
  const upload = await connector.uploadAttachment({
    ...scope,
    threadId,
    command: {
      intentId: attachmentIntentId,
      requestHash: calculateFeedbackCommandHash({ operation: "phase5-attachment", runId }),
      attachmentId,
      messageId,
      filename: `feedback-phase5-${runId}.txt`,
      contentType: "text/plain",
      sizeBytes: attachmentBytes.byteLength,
      contentHash: attachmentHash,
      purpose: "evidence"
    },
    source: { sizeBytes: attachmentBytes.byteLength, async *read() { yield attachmentBytes; } }
  });
  if (!("attachment" in upload) || upload.attachment.attachmentId !== attachmentId) throw new Error("Jira attachment resultが不正です");
  const download = await connector.getAttachment({ ...scope, threadId, attachmentId });
  const downloaded = await collect(download.body);
  if (`sha256:${createHash("sha256").update(downloaded).digest("hex")}` !== attachmentHash) throw new Error("Jira attachment hashが不一致です");
  evidence.attachmentRoundtrip = true;

  const candidate = (await connector.findThreadCandidatesById({ ...scope, threadId }))[0];
  if (!candidate) throw new Error("Jira candidateが消失しました");
  const reread = await connector.readCandidate(candidate);
  if (reread.thread.messages.length < 2 || reread.thread.threadId !== threadId) throw new Error("Jira thread再読込が不正です");
  const rereadReply = reread.thread.messages.find((message) => message.messageId === messageId);
  if (!rereadReply || rereadReply.body !== "Phase 5 revised reply" ||
      rereadReply.revisions.at(-1)?.revisionId !== revisionId) {
    throw new Error("Jira署名本文またはrevision chain再読込が不正です");
  }
  evidence.bodyIntegrityVerified = true;
  if (!rereadReply.attachments.some((attachment) => attachment.attachmentId === attachmentId) ||
      reread.thread.messages.some((message) => message.messageId !== messageId &&
        message.attachments.some((attachment) => attachment.attachmentId === attachmentId))) {
    throw new Error("Jira attachmentのmessage関連付けが不正です");
  }
  evidence.attachmentMessageBindingVerified = true;
  evidence.threadReference = await runFeedbackReferenceAcceptance({
    scope: { ...scope, resource: { kind: "record", key: `reference-${runId}` } },
    title: `[feedback-phase5:${runId}] HTTP reference acceptance`,
    runtimeProfile: { id: "jira-live-reference", connectorKey: "jira-cloud", application: "feedback-system", environment: "phase5-acceptance" },
    codec, envelopeKid: "phase5-ephemeral", envelopeSecret,
    providerCredential: JSON.stringify({ kind: "jira-cloud-basic", email, apiToken }),
    createRepository(participantId) {
      const repository = createFeedbackJiraCloudConnector({
        configuration: { profileId: scope.profileId, installationId: scope.installationId,
          application: "feedback-system", environment: "phase5-acceptance", participantId, issueTypeId,
          maximumAttachmentBytes: 1048576, attachmentContentTypes: ["text/plain"], pageSize: 50, recoveryRetryAfterSeconds: 2 },
        transport: createJiraCloudFetchTransport({ baseUrl: siteUrl, authorization, fetch: jiraFetch, timeoutMilliseconds: 30000 }),
        envelopeCodec: codec
      });
      return trackJiraLiveRepository(repository, issueIds);
    }
  });
} finally {
  if (issueId) issueIds.add(issueId);
  let failures = 0;
  for (const ownedId of issueIds) {
    try {
      const response = await fetch(`${siteUrl}/rest/api/3/issue/${encodeURIComponent(ownedId)}?deleteSubtasks=true`, {
        method: "DELETE",
        headers: { Accept: "application/json", Authorization: authorization }
      });
      if (response.status !== 204 && response.status !== 404) failures++;
    } catch { failures++; }
  }
  evidence.cleanup = issueIds.size > 0 && failures === 0 ? "deleted-run-owned-issue" : "failed-to-delete-run-owned-issues";
  process.stderr.write(`${JSON.stringify({ kind: "jira-live-cleanup", targetCount: issueIds.size, failureCount: failures, cleanup: evidence.cleanup })}\n`);
}

if (evidence.cleanup !== "deleted-run-owned-issue") throw new Error(`Jira acceptance cleanupに失敗しました: ${evidence.cleanup}`);
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

async function discoverIssueType() {
  const response = await fetch(`${siteUrl}/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes?maxResults=100`, {
    headers: { Accept: "application/json", Authorization: authorization }
  });
  if (!response.ok) throw new Error(`Jira issue type discoveryに失敗しました: ${response.status}`);
  const body = await response.json();
  const values = Array.isArray(body?.issueTypes)
    ? body.issueTypes
    : Array.isArray(body)
      ? body
      : Array.isArray(body?.values)
        ? body.values
        : [];
  const selected = values.find((value) => value && value.subtask !== true && value.name === "Task") ??
    values.find((value) => value && value.subtask !== true);
  if (!selected || typeof selected.id !== "string") throw new Error("Jira create可能なissue typeがありません");
  return selected.id;
}

async function waitForUniqueCandidate() {
  const deadline = Date.now() + 60_000;
  do {
    const candidates = await connector.findThreadCandidatesById({ ...scope, threadId });
    if (candidates.length === 1) return candidates[0].providerRef.objectId;
    if (candidates.length > 1) throw new Error("Jira threadIdが複数issueへindexされています");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  throw new Error("Jira entity property indexが60秒以内に候補を返しませんでした");
}

async function jiraFetch(input, init) {
  const response = await fetch(input, { ...init, body: init.body, signal: init.signal, duplex: init.duplex });
  const trackCreatedIssue = (value) => {
    if (init.method === "POST" && new URL(input).pathname === "/rest/api/3/issue" &&
        value && typeof value.id === "string") {
      issueId = value.id;
      issueIds.add(value.id);
    }
    return value;
  };
  return {
    status: response.status,
    headers: response.headers,
    async json() {
      return trackCreatedIssue(await response.json());
    },
    async text() {
      const source = await response.text();
      if (init.method === "POST" && new URL(input).pathname === "/rest/api/3/issue") {
        try { trackCreatedIssue(JSON.parse(source)); } catch { /* Connector側でprovider payload errorとして処理する。 */ }
      }
      return source;
    },
    body: response.body
  };
}

async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name}がありません`);
  return value;
}

function origin(value) {
  const url = new URL(value);
  if (url.origin !== value || url.protocol !== "https:" || url.username || url.password) throw new Error("Jira site URLが不正です");
  return value;
}

function stableKey(value) {
  if (!/^[A-Z][A-Z0-9_]{1,127}$/u.test(value)) throw new Error("Jira project keyが不正です");
  return value;
}

function implementationDigest() {
  return feedbackLiveDigest("jira-cloud");
}
