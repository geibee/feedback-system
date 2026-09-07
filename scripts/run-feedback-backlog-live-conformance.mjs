#!/usr/bin/env node
// Backlog SaaSへrun-owned issueだけを作成し、実Connectorのlive Conformance後に削除する。
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  assertFeedbackBacklogProvisioning,
  BacklogConnectorProblem,
  BacklogRestV2Client,
  createBacklogFetchTransport,
  createFeedbackBacklogConnector
} from "@geibee/feedback-connector-backlog";
import { calculateFeedbackCommandHash, createFeedbackEnvelopeCodec } from "@geibee/feedback-envelope";
import { feedbackLiveDigest } from "./lib/feedback-live-digest.mjs";
import { runFeedbackReferenceAcceptance } from "./lib/feedback-reference-acceptance.mjs";
import { assertBestEffortDuplicateRecovery } from "./lib/feedback-duplicate-acceptance.mjs";

const baseUrl = backlogOrigin(required("FEEDBACK_BACKLOG_ACCEPTANCE_BASE_URL"));
const apiKey = required("FEEDBACK_BACKLOG_ACCEPTANCE_API_KEY");
const projectKey = stableProjectKey(required("FEEDBACK_BACKLOG_ACCEPTANCE_PROJECT_KEY"));
const profileId = "backlog-live-conformance";
const installationId = "backlog-live-site";
const application = "feedback-system";
const environment = "live-conformance";

if (process.argv.includes("--reconstruct")) {
  await reconstructInFreshProcess();
  process.exit(0);
}
if (process.env.FEEDBACK_BACKLOG_ACCEPTANCE_CLEANUP_POLICY !== "delete-run-owned") {
  throw new Error("FEEDBACK_BACKLOG_ACCEPTANCE_CLEANUP_POLICY=delete-run-ownedが必要です");
}

const runId = randomUUID();
const threadId = randomUUID();
const participantId = randomUUID();
const signingSecret = randomBytes(32);
const resource = { kind: "record", key: `backlog-live-${runId}` };
const scope = { profileId, installationId, workspaceId: projectKey, resource };
const issueIds = new Set();
const fault = { loseNextIssueResponse: false, loseNextCommentResponse: false };
const faultObservation = {
  commentPostStarted: false,
  commentPostStatus: null,
  requestedCommentContent: null,
  committedCommentContent: null,
  commentListStatus: null,
  commentListCount: null,
  requestedContentListed: false,
  committedContentListed: false
};
const facts = await discoverFacts();
const configuration = {
  profileId,
  installationId,
  application,
  environment,
  participantId,
  workspaceId: projectKey,
  workspaceDisplayName: facts.project.name,
  projectId: facts.project.id,
  issueTypeId: facts.issueType.id,
  priorityId: facts.priority.id,
  customFieldIds: Object.fromEntries(Object.entries(facts.fields).map(([name, value]) => [name, value.id])),
  pageSize: 100,
  recoveryRetryAfterSeconds: 2,
  maximumMetadataBytes: 32_768
};
const codec = feedbackCodec(signingSecret);
const baseTransport = createBacklogFetchTransport({ baseUrl, apiKey, fetch: backlogFetch, timeoutMilliseconds: 30_000 });
const connector = createFeedbackBacklogConnector({
  configuration,
  transport: faultInjectingTransport(baseTransport),
  envelopeCodec: codec
});

// 回収と事前確認を同じ検索結果と誤認しないよう、実呼出しの候補件数だけを記録する。
// provider ID、本文、credentialは診断出力へ含めない。検索結果や判定は変更しない。
let threadObservationPhase = null;
let duplicateRecoveryState = null;
let replyResultState = null;
const threadCandidateCounts = [];
let duplicateRecoveryCandidates;
const findThreadCandidates = connector.findThreadCandidatesById.bind(connector);
connector.findThreadCandidatesById = async (...args) => {
  const candidates = await findThreadCandidates(...args);
  if (threadObservationPhase === "duplicate-recovery") duplicateRecoveryCandidates = candidates;
  if (threadObservationPhase !== null) {
    threadCandidateCounts.push({ phase: threadObservationPhase, count: candidates.length });
  }
  return candidates;
};

const createIntentId = randomUUID();
const createRequestHash = commandHash("create", { runId, threadId, resource });
const replyIntentId = randomUUID();
const replyRequestHash = commandHash("reply", { runId, threadId });
const messageId = randomUUID();
const revisionIntentId = randomUUID();
const revisionRequestHash = commandHash("revision", { runId, threadId, messageId });
const revisionId = randomUUID();
const evidence = {
  schemaVersion: "1",
  kind: "backlog-stage-b-live-conformance",
  contractVersion: "2.0.0-alpha.3",
  implementationDigest: implementationDigest(),
  executedAt: new Date().toISOString(),
  api: "Backlog API v2",
  siteType: "Backlog SaaS free trial",
  tenantIdentifiersRemoved: true,
  provisioning: {
    fourTextCustomFieldsReady: false,
    projectIssueTypePriorityReady: false
  },
  capabilities: {
    createReplyRevisionRecoverable: false,
    attachmentReadUploadUnsupported: false,
    resourceDiscoveryUnsupported: false
  },
  recovery: {
    zeroCreateHitPending: false,
    createResponseLostAfterCommit: false,
    createRecoveredFromProvider: false,
    replyResponseLostAfterCommit: false,
    replyRecoveredFromProvider: false,
    revisionResponseLostAfterCommit: false,
    revisionRecoveredFromProvider: false,
    observedDuplicateDecisionVerified: false,
    automaticWriteRetry: false
  },
  roundtrip: {
    workspace: false,
    resourceProjection: false,
    body: false,
    reply: false,
    appendOnlyRevision: false,
    signedMetadata: false
  },
  restartReconstruction: {
    separateProcess: false,
    providerObjectIdentifiersPassed: false,
    threadRecovered: false,
    intentsRecovered: false,
    resourceProjectionRecovered: false
  },
  cleanup: "not-started"
};

try {
  await assertFeedbackBacklogProvisioning(new BacklogRestV2Client(baseTransport), configuration);
  evidence.provisioning.fourTextCustomFieldsReady = true;
  evidence.provisioning.projectIssueTypePriorityReady = true;

  const capabilities = await connector.getCapabilities();
  evidence.capabilities.createReplyRevisionRecoverable =
    capabilities.operationGuarantees.create === "recoverable" &&
    capabilities.operationGuarantees.reply === "recoverable" &&
    capabilities.operationGuarantees.revision === "recoverable";
  evidence.capabilities.attachmentReadUploadUnsupported =
    capabilities.operationGuarantees.attachmentUpload === "unsupported" &&
    !capabilities.backendOperations.includes("feedback:attachment:upload") &&
    !capabilities.backendOperations.includes("feedback:attachment:read");
  await expectUnsupported(() => connector.uploadAttachment());
  await expectUnsupported(() => connector.getAttachment());
  await expectUnsupported(() => connector.listResources({ profileId, workspaceId: projectKey }));
  evidence.capabilities.resourceDiscoveryUnsupported = true;

  const workspaces = await connector.listWorkspaces(profileId);
  assert(workspaces.items.length === 1 && workspaces.items[0]?.workspaceId === projectKey && workspaces.nextCursor === null,
    "Backlog workspace round-tripが不正です");
  evidence.roundtrip.workspace = true;

  const missing = await connector.recoverIntent({
    ...scope,
    threadId,
    intentId: createIntentId,
    requestHash: createRequestHash,
    operation: "feedback:create"
  });
  assert(missing.state === "pending" && missing.automaticWriteAllowed === false,
    "Backlog create 0件判定がpendingではありません");
  evidence.recovery.zeroCreateHitPending = true;

  fault.loseNextIssueResponse = true;
  const createResult = await connector.createThread({
    ...scope,
    command: {
      threadId,
      intentId: createIntentId,
      requestHash: createRequestHash,
      resource,
      title: `[feedback-backlog-stage-b:${runId}] primary`,
      body: "Backlog Stage B Connector live Conformance。削除対象。"
    }
  });
  evidence.recovery.createResponseLostAfterCommit = !fault.loseNextIssueResponse;
  await waitForCompleted(createResult, {
    threadId,
    intentId: createIntentId,
    requestHash: createRequestHash,
    operation: "feedback:create"
  });
  evidence.recovery.createRecoveredFromProvider = true;

  const candidate = await waitForUniqueThreadCandidate();
  const resourceCandidate = await waitForUniqueResourceCandidate();
  assert(candidate.providerRef.objectId === resourceCandidate.providerRef.objectId,
    "threadId検索とresource検索が同じBacklog issueを指しません");
  evidence.roundtrip.resourceProjection = true;
  const resolvedOptions = { threadRef: candidate.providerRef };
  fault.loseNextCommentResponse = true;
  threadObservationPhase = "reply";
  const replyResult = await connector.reply({
    ...scope,
    threadId,
    command: { intentId: replyIntentId, requestHash: replyRequestHash, messageId, body: "Backlog Stage B reply" }
  }, resolvedOptions);
  replyResultState = replyResult.state ?? replyResult.disposition;
  threadObservationPhase = null;
  evidence.recovery.replyResponseLostAfterCommit = !fault.loseNextCommentResponse;
  await waitForCompleted(replyResult, {
    threadId,
    intentId: replyIntentId,
    requestHash: replyRequestHash,
    operation: "feedback:reply"
  }, resolvedOptions);
  evidence.recovery.replyRecoveredFromProvider = true;

  fault.loseNextCommentResponse = true;
  threadObservationPhase = "revision";
  const revisionResult = await connector.appendRevision({
    ...scope,
    threadId,
    messageId,
    command: {
      intentId: revisionIntentId,
      requestHash: revisionRequestHash,
      revisionId,
      expectedRevisionId: messageId,
      body: "Backlog Stage B revised reply"
    }
  }, resolvedOptions);
  threadObservationPhase = null;
  evidence.recovery.revisionResponseLostAfterCommit = !fault.loseNextCommentResponse;
  await waitForCompleted(revisionResult, {
    threadId,
    intentId: revisionIntentId,
    requestHash: revisionRequestHash,
    operation: "feedback:revise"
  }, resolvedOptions);
  evidence.recovery.revisionRecoveredFromProvider = true;

  const reread = await connector.readCandidate(candidate);
  const initial = reread.thread.messages.find((message) => message.messageId === threadId);
  const reply = reread.thread.messages.find((message) => message.messageId === messageId);
  assert(initial?.body === "Backlog Stage B Connector live Conformance。削除対象。", "Backlog初期本文が一致しません");
  assert(reply?.body === "Backlog Stage B revised reply", "Backlog reply改訂本文が一致しません");
  assert(reply.revisions.length === 1 && reply.revisions[0]?.revisionId === revisionId &&
    reply.revisions[0]?.body === "Backlog Stage B revised reply", "Backlog append-only revisionが一致しません");
  const metadata = reread.legacyMetadata;
  assert(isRecord(metadata) && isRecord(metadata.recoverySeed) &&
    metadata.recoverySeed.threadId === threadId && Array.isArray(metadata.commentMarkers) && metadata.commentMarkers.length === 2,
  "Backlog署名metadataの再読込が不正です");
  evidence.roundtrip.body = true;
  evidence.roundtrip.reply = true;
  evidence.roundtrip.appendOnlyRevision = true;
  evidence.roundtrip.signedMetadata = true;

  const reconstruction = await spawnReconstruction({
    configuration,
    scope,
    threadId,
    create: { intentId: createIntentId, requestHash: createRequestHash },
    reply: { intentId: replyIntentId, requestHash: replyRequestHash },
    revision: { intentId: revisionIntentId, requestHash: revisionRequestHash },
    messageId,
    revisionId
  });
  evidence.restartReconstruction.separateProcess = reconstruction.pid !== process.pid;
  evidence.restartReconstruction.threadRecovered = reconstruction.threadRecovered;
  evidence.restartReconstruction.intentsRecovered = reconstruction.intentsRecovered;
  evidence.restartReconstruction.resourceProjectionRecovered = reconstruction.resourceProjectionRecovered;

  const duplicateIntentId = randomUUID();
  const duplicateRequestHash = commandHash("duplicate", { runId, threadId });
  await connector.createThread({
    ...scope,
    command: {
      threadId,
      intentId: duplicateIntentId,
      requestHash: duplicateRequestHash,
      resource,
      title: `[feedback-backlog-stage-b:${runId}] duplicate`,
      body: "Backlog Stage B duplicate candidate。削除対象。"
    }
  });
  threadObservationPhase = "duplicate-recovery";
  const duplicateQuery = {
    ...scope,
    threadId,
    intentId: createIntentId,
    requestHash: createRequestHash,
    operation: "feedback:create"
  };
  const duplicateResult = await connector.recoverIntent(duplicateQuery);
  duplicateRecoveryState = duplicateResult.state;
  threadObservationPhase = null;
  assert(Array.isArray(duplicateRecoveryCandidates), "回収呼出しの候補観測がありません");
  evidence.duplicateObservation = assertBestEffortDuplicateRecovery(duplicateRecoveryCandidates, duplicateQuery, duplicateResult);
  evidence.recovery.observedDuplicateDecisionVerified = true;

  let referenceDuplicate;
  const referenceRepository = (currentParticipantId) => createFeedbackBacklogConnector({
    configuration: { ...configuration, participantId: currentParticipantId },
    transport: faultInjectingTransport(baseTransport), envelopeCodec: codec
  });
  evidence.threadReference = await runFeedbackReferenceAcceptance({
    scope: { ...scope, resource: { kind: "record", key: `reference-${runId}` } },
    title: `[feedback-backlog-stage-b:${runId}] HTTP reference acceptance`,
    runtimeProfile: { id: "backlog-live-reference", connectorKey: "backlog", application, environment },
    codec, envelopeKid: "backlog-live-ephemeral", envelopeSecret: signingSecret,
    providerCredential: JSON.stringify({ kind: "backlog-api-key", apiKey }),
    createRepository: referenceRepository,
    async createDuplicate(query) {
      await referenceRepository(participantId).createThread(query, { onThreadResolved(ref) { referenceDuplicate = ref; } });
      assert(referenceDuplicate, "参照分離検証用の重複issueを作成できません");
    },
    async verifyDuplicate(referenceThreadId) {
      const candidates = await referenceRepository(participantId).findThreadCandidatesById({
        ...scope, resource: { kind: "record", key: `reference-${runId}` }, threadId: referenceThreadId
      }, { threadRef: referenceDuplicate });
      const record = await referenceRepository(participantId).readCandidate(candidates[0]);
      assert(record.thread.messages.length === 1 && record.thread.messages[0].body === "別issue。固定参照の操作対象ではない",
        "固定参照の操作が別issueへ混入しました");
    }
  });
} finally {
  const discovered = await findRunOwnedIssues().catch(() => []);
  for (const issue of discovered) if (Number.isSafeInteger(issue.id)) issueIds.add(issue.id);
  const failures = [];
  for (const issueId of issueIds) {
    try { await deleteIssue(issueId); } catch (error) { failures.push(error); }
  }
  const remaining = await findRunOwnedIssues().catch(() => [{ id: "unknown" }]);
  evidence.cleanup = failures.length === 0 && remaining.length === 0
    ? "deleted-all-run-owned-issues"
    : "failed-to-delete-all-run-owned-issues";
  // 本試験の例外時もcleanup結果が失われないよう、成功証跡とは分離してstderrへ出す。
  process.stderr.write(`${JSON.stringify({
    kind: "backlog-stage-b-live-diagnostic",
    executedAt: evidence.executedAt,
    threadCandidateCounts,
    replyResultState,
    duplicateRecoveryState,
    cleanup: evidence.cleanup,
    cleanupTargetCount: issueIds.size,
    cleanupFailureCount: failures.length,
    remainingIssueCount: remaining.length
  })}\n`);
}

assert(evidence.cleanup === "deleted-all-run-owned-issues", `Backlog Stage B cleanupに失敗しました: ${evidence.cleanup}`);
assert(Object.values(evidence.provisioning).every(Boolean), "Backlog Stage B provisioningが不完全です");
assert(Object.values(evidence.capabilities).every(Boolean), "Backlog Stage B capabilitiesが不完全です");
assert(Object.values(evidence.recovery).every((value) => value === true || value === false) &&
  Object.entries(evidence.recovery).every(([name, value]) => name === "automaticWriteRetry" ? value === false : value === true),
"Backlog Stage B recoveryが不完全です");
assert(Object.values(evidence.roundtrip).every(Boolean), "Backlog Stage B round-tripが不完全です");
assert(evidence.restartReconstruction.separateProcess &&
  evidence.restartReconstruction.providerObjectIdentifiersPassed === false &&
  evidence.restartReconstruction.threadRecovered && evidence.restartReconstruction.intentsRecovered &&
  evidence.restartReconstruction.resourceProjectionRecovered, "Backlog Stage B再起動再構築が不完全です");
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

async function reconstructInFreshProcess() {
  const input = JSON.parse(required("FEEDBACK_BACKLOG_RECONSTRUCT_INPUT"));
  assert(!("issueId" in input) && !("issueKey" in input) && !("objectId" in input) && !("commentId" in input),
    "再構築processへprovider object IDを渡してはいけません");
  const secret = Buffer.from(required("FEEDBACK_BACKLOG_SIGNING_SECRET"), "base64url");
  assert(secret.byteLength === 32, "再構築processの署名鍵が不正です");
  const transport = createBacklogFetchTransport({ baseUrl, apiKey, fetch: backlogFetch, timeoutMilliseconds: 30_000 });
  const child = createFeedbackBacklogConnector({
    configuration: input.configuration,
    transport,
    envelopeCodec: feedbackCodec(secret)
  });
  const candidates = await waitForChildCandidates(async () =>
    child.findThreadCandidatesById({ ...input.scope, threadId: input.threadId }), "thread", 3);
  const resourceCandidates = await waitForChildCandidates(async () =>
    (await child.findThreadCandidates(input.scope)).candidates, "resource projection", 3);
  const record = await child.readCandidate(candidates[0]);
  const reply = record.thread.messages.find((message) => message.messageId === input.messageId);
  assert(record.thread.threadId === input.threadId && reply?.revisions.at(-1)?.revisionId === input.revisionId,
    "別processのBacklog thread再構築が不正です");
  const recoveries = await Promise.all([
    child.recoverIntent({ ...input.scope, threadId: input.threadId, ...input.create, operation: "feedback:create" }, { threadRef: candidates[0].providerRef }),
    child.recoverIntent({ ...input.scope, threadId: input.threadId, ...input.reply, operation: "feedback:reply" }, { threadRef: candidates[0].providerRef }),
    child.recoverIntent({ ...input.scope, threadId: input.threadId, ...input.revision, operation: "feedback:revise" }, { threadRef: candidates[0].providerRef })
  ]);
  process.stdout.write(JSON.stringify({
    pid: process.pid,
    threadRecovered: true,
    intentsRecovered: recoveries.every((value) => value.state === "completed"),
    resourceProjectionRecovered: resourceCandidates[0]?.providerRef.objectId === candidates[0]?.providerRef.objectId
  }));
}

async function waitForChildCandidates(read, label, requiredConsecutive) {
  const deadline = Date.now() + 60_000;
  let consecutive = 0;
  do {
    const candidates = await read();
    if (candidates.length === 1) {
      consecutive += 1;
      if (consecutive >= requiredConsecutive) return candidates;
    } else {
      consecutive = 0;
    }
    if (candidates.length > 1) throw new Error(`別processのBacklog ${label}候補が複数あります`);
    await delay(1_000);
  } while (Date.now() < deadline);
  throw new Error(`別processでBacklog ${label}を60秒以内に一意解決できません`);
}

async function discoverFacts() {
  const transport = createBacklogFetchTransport({ baseUrl, apiKey, fetch: backlogFetch, timeoutMilliseconds: 30_000 });
  const client = new BacklogRestV2Client(transport);
  const project = await client.getProject(projectKey);
  const [fields, issueTypes, priorities] = await Promise.all([
    client.getCustomFields(project.id),
    client.getIssueTypes(project.id),
    client.getPriorities()
  ]);
  const fieldNames = { threadId: "feedback.threadId", intentId: "feedback.intentId", requestHash: "feedback.requestHash", resourceKey: "feedback.resourceKey" };
  const selectedFields = {};
  for (const [key, name] of Object.entries(fieldNames)) {
    const matches = fields.filter((field) => field.name === name && field.typeId === 1 && field.required === false);
    assert(matches.length === 1, `Backlog ${name} Text custom fieldを一意に解決できません`);
    selectedFields[key] = matches[0];
  }
  const issueType = issueTypes.find((value) => value.name === "タスク") ?? issueTypes[0];
  const priority = priorities.find((value) => value.id === 3) ?? priorities[0];
  assert(issueType && priority, "Backlog issue typeまたはpriorityがありません");
  return { project, fields: selectedFields, issueType, priority };
}

function faultInjectingTransport(transport) {
  return {
    async request(request) {
      const isCommentPost = request.method === "POST" && /^\/api\/v2\/issues\/[^/]+\/comments$/u.test(request.path);
      if (isCommentPost) {
        faultObservation.commentPostStarted = true;
        const content = request.body?.values?.content;
        faultObservation.requestedCommentContent = typeof content === "string" ? content : null;
      }
      const response = await transport.request(request);
      if (request.method === "POST" && request.path === "/api/v2/issues") {
        const id = isRecord(response.body) ? response.body.id : null;
        assert(Number.isSafeInteger(id), "Backlog create responseのcleanup用IDが不正です");
        issueIds.add(id);
        if (fault.loseNextIssueResponse) {
          fault.loseNextIssueResponse = false;
          throw unknownWrite("Backlog issue create responseをテスト用に破棄しました");
        }
      }
      if (isCommentPost && fault.loseNextCommentResponse) {
        faultObservation.commentPostStatus = response.status;
        faultObservation.committedCommentContent = isRecord(response.body) && typeof response.body.content === "string"
          ? response.body.content
          : null;
        if (response.status < 200 || response.status >= 300) return response;
        fault.loseNextCommentResponse = false;
        throw unknownWrite("Backlog comment create responseをテスト用に破棄しました");
      }
      if (request.method === "GET" && /^\/api\/v2\/issues\/[^/]+\/comments\?/u.test(request.path)) {
        faultObservation.commentListStatus = response.status;
        faultObservation.commentListCount = Array.isArray(response.body) ? response.body.length : null;
        faultObservation.requestedContentListed = typeof faultObservation.requestedCommentContent === "string" &&
          Array.isArray(response.body) && response.body.some((value) => isRecord(value) && value.content === faultObservation.requestedCommentContent);
        faultObservation.committedContentListed = typeof faultObservation.committedCommentContent === "string" &&
          Array.isArray(response.body) && response.body.some((value) => isRecord(value) && value.content === faultObservation.committedCommentContent);
      }
      return response;
    }
  };
}

async function waitForCompleted(initial, intent, options) {
  if (initial?.state === "completed") return initial;
  const deadline = Date.now() + 60_000;
  do {
    const result = await connector.recoverIntent({ ...scope, ...intent }, options);
    if (result.state === "completed") return result;
    if (result.state === "repair_required") throw new Error(`${intent.operation}がrepair_requiredになりました`);
    await delay(1_000);
  } while (Date.now() < deadline);
  throw new Error(`${intent.operation}を60秒以内に回収できませんでした: ${JSON.stringify({
    commentPostStarted: faultObservation.commentPostStarted,
    commentPostStatus: faultObservation.commentPostStatus,
    commentListStatus: faultObservation.commentListStatus,
    commentListCount: faultObservation.commentListCount,
    requestedContentListed: faultObservation.requestedContentListed,
    committedContentListed: faultObservation.committedContentListed
  })}`);
}

async function waitForUniqueThreadCandidate() {
  const candidates = await waitForThreadCandidateCount(1, 3);
  return candidates[0];
}

async function waitForThreadCandidateCount(count, requiredConsecutive = 1) {
  const deadline = Date.now() + 60_000;
  let consecutive = 0;
  do {
    const candidates = await connector.findThreadCandidatesById({ ...scope, threadId });
    if (candidates.length === count) {
      consecutive += 1;
      if (consecutive >= requiredConsecutive) return candidates;
    } else {
      consecutive = 0;
    }
    if (candidates.length > count) throw new Error(`Backlog thread候補が期待件数${count}を超えました`);
    await delay(1_000);
  } while (Date.now() < deadline);
  throw new Error(`Backlog thread候補が60秒以内に${count}件になりませんでした`);
}

async function waitForUniqueResourceCandidate() {
  const deadline = Date.now() + 60_000;
  do {
    const page = await connector.findThreadCandidates(scope);
    if (page.candidates.length === 1) return page.candidates[0];
    if (page.candidates.length > 1) throw new Error("Backlog resource候補が複数あります");
    await delay(1_000);
  } while (Date.now() < deadline);
  throw new Error("Backlog resource projectionが60秒以内に見つかりませんでした");
}

async function spawnReconstruction(input) {
  const child = spawn(process.execPath, ["scripts/run-feedback-backlog-live-conformance.mjs", "--reconstruct"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FEEDBACK_BACKLOG_RECONSTRUCT_INPUT: JSON.stringify(input),
      FEEDBACK_BACKLOG_SIGNING_SECRET: signingSecret.toString("base64url")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  let errorOutput = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errorOutput += chunk; });
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (status !== 0) throw new Error(`Backlog別process再構築が失敗しました: ${errorOutput.slice(0, 500)}`);
  return JSON.parse(output);
}

async function findRunOwnedIssues() {
  const query = new URLSearchParams();
  query.append("projectId[]", String(facts.project.id));
  query.set("keyword", runId);
  query.set("count", "100");
  const response = await baseTransport.request({ method: "GET", path: `/api/v2/issues?${query.toString()}` });
  assert(response.status === 200 && Array.isArray(response.body), "Backlog cleanup検索が失敗しました");
  return response.body.filter((issue) => isRecord(issue) && typeof issue.summary === "string" &&
    issue.summary.startsWith(`[feedback-backlog-stage-b:${runId}]`));
}

async function deleteIssue(issueId) {
  const response = await fetch(`${baseUrl}/api/v2/issues/${encodeURIComponent(String(issueId))}`, {
    method: "DELETE",
    headers: { Accept: "application/json", "Backlog-API-Key": apiKey },
    redirect: "error"
  });
  if (response.status !== 200 && response.status !== 204 && response.status !== 404) {
    throw new Error(`Backlog issue cleanupがstatus ${response.status}で失敗しました`);
  }
}

async function expectUnsupported(operation) {
  try { await operation(); } catch (error) {
    if (error instanceof BacklogConnectorProblem && error.code === "feedback.unsupported") return;
    throw error;
  }
  throw new Error("Backlog unsupported操作が成功しました");
}

async function backlogFetch(input, init) {
  const response = await fetch(input, init);
  return { status: response.status, headers: response.headers, text: () => response.text() };
}

function feedbackCodec(secret) {
  return createFeedbackEnvelopeCodec([{ kid: "backlog-live-ephemeral", secret, state: "active" }]);
}

function unknownWrite(message) {
  return new BacklogConnectorProblem({
    message,
    status: 504,
    code: "feedback.provider_timeout",
    retryable: true,
    resultUnknown: true
  });
}

function commandHash(operation, value) {
  return calculateFeedbackCommandHash({ operation: `feedback:${operation}`, ...value });
}

function implementationDigest() {
  return feedbackLiveDigest("backlog");
}

function backlogOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) {
    throw new Error("Backlog base URLはcredentialなしのHTTPS originで指定してください");
  }
  return url.origin;
}

function stableProjectKey(value) {
  if (!/^[A-Z][A-Z0-9_]{1,127}$/u.test(value)) throw new Error("Backlog project keyが不正です");
  return value;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name}がありません`);
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
