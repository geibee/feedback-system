#!/usr/bin/env node
// Backlog SaaSのrun-owned issueだけを使い、Stage AのDBレス適用可否を実測する。
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  calculateFeedbackCommandHash,
  createFeedbackEnvelopeCodec
} from "@geibee/feedback-envelope";

const baseUrl = backlogOrigin(required("BACKLOG_STAGE_A_BASE_URL"));
const apiKey = required("BACKLOG_STAGE_A_API_KEY");
const projectKey = stableProjectKey(required("BACKLOG_STAGE_A_PROJECT_KEY"));
const profileId = "backlog-stage-a-live";
const application = "feedback-system";
const environment = "stage-a";
const markerNames = Object.freeze({
  envelope: "feedback-envelope:v2",
  recovery: "feedback-recovery-seed:v2",
  message: "feedback-message-marker:v2",
  attachment: "feedback-attachment-marker:v2"
});
let lastRequestAt = 0;

if (process.argv.includes("--reconstruct")) {
  await reconstructInFreshProcess();
  process.exit(0);
}

if (process.env.BACKLOG_STAGE_A_CLEANUP_POLICY !== "delete-run-owned") {
  throw new Error("BACKLOG_STAGE_A_CLEANUP_POLICY=delete-run-ownedが必要です");
}

const runId = randomUUID();
const summaryPrefix = `[feedback-stage-a-live:${runId}]`;
const signingSecret = randomBytes(32);
const codec = feedbackCodec(signingSecret);
const threadId = randomUUID();
const createIntentId = randomUUID();
const participantId = randomUUID();
const resource = { kind: "record", key: `stage-a-${runId}` };
const issueBody = "Backlog Stage A managed live acceptance。削除対象。";
const title = `${summaryPrefix} primary`;
const createRequestHash = calculateFeedbackCommandHash({
  operation: "feedback:create",
  threadId,
  title,
  body: issueBody,
  resource
});
const evidence = {
  schemaVersion: "1",
  kind: "backlog-stage-a-live-acceptance",
  contractVersion: "2.0.0-alpha.2",
  implementationDigest: implementationDigest(),
  executedAt: new Date().toISOString(),
  api: "Backlog API v2",
  siteType: "Backlog SaaS free trial",
  tenantIdentifiersRemoved: true,
  credentialWire: "Backlog-API-Key header",
  provisioning: {
    projectAccessible: false,
    credentialSubjectIsProjectAdministrator: false,
    textCustomFieldsReady: false
  },
  firstThreadWrite: {
    bodyAndRecoveryTripletSingleRequest: false,
    directReadRoundtrip: false,
    signedEnvelopeBoundAfterProviderIdentityResolution: false
  },
  threadLookup: {
    zeroExactHitsDecision: "not-observed",
    oneExactHitRecoveredAfterResponseLoss: false,
    multipleExactHitsDecision: "not-observed",
    exactPostFilterApplied: false,
    visibilityMilliseconds: null
  },
  comments: {
    zeroMarkerHitsDecision: "not-observed",
    replyBodyAndMarkerSingleRequest: false,
    replyRecoveredAfterResponseLoss: false,
    multipleMarkerHitsDecision: "not-observed",
    revisionAppendOnly: false,
    revisionRecoveredAfterResponseLoss: false
  },
  attachment: {
    initialUploadResponseDiscarded: false,
    initialUploadAutomaticRetry: false,
    discardedUploadAttachedByCleanupHarness: false,
    temporaryUploadSucceeded: false,
    metadataAndAttachSingleCommentRequest: false,
    finalCommentRecoveredAfterResponseLoss: false,
    temporaryAndFinalProviderIdEqual: false,
    binaryHashRoundtrip: false,
    capabilityClassification: "not-observed",
    unknownInitialUploadDecision: "repair_required",
    automaticBinaryRetry: false
  },
  restartReconstruction: {
    separateProcess: false,
    providerIdentifiersPassedToProcess: false,
    threadEnvelopeVerified: false,
    replyVerified: false,
    revisionVerified: false,
    attachmentVerified: false
  },
  hardGate: {
    status: "pending",
    passed: false,
    recoverableOperations: [],
    unsupportedOperations: []
  },
  automaticWriteRetry: false,
  cleanup: "not-started"
};

let facts;
const cleanupIssueIds = new Set();
try {
  facts = await discoverFacts();
  evidence.provisioning.projectAccessible = true;
  evidence.provisioning.credentialSubjectIsProjectAdministrator = facts.user.roleType === 1;
  evidence.provisioning.textCustomFieldsReady = true;

  const absent = await findExactThreadCandidates(facts, randomUUID());
  assert(absent.exact.length === 0, "未使用threadIdの検索結果が0件ではありません");
  evidence.threadLookup.zeroExactHitsDecision = "pending";
  evidence.threadLookup.exactPostFilterApplied = true;

  const recoverySeed = { schemaVersion: "2", threadId, intentId: createIntentId, requestHash: createRequestHash };
  const firstDescription = carrier(issueBody, markerNames.recovery, recoverySeed);
  await createIssueAndDiscardResponse(facts, {
    summary: title,
    description: firstDescription,
    threadId,
    intentId: createIntentId,
    requestHash: createRequestHash
  });
  evidence.firstThreadWrite.bodyAndRecoveryTripletSingleRequest = true;

  const visibilityStartedAt = Date.now();
  const primary = await waitForExactCandidateCount(facts, threadId, 1);
  evidence.threadLookup.visibilityMilliseconds = Date.now() - visibilityStartedAt;
  evidence.threadLookup.oneExactHitRecoveredAfterResponseLoss = true;
  cleanupIssueIds.add(String(primary.id));

  assert(firstDescription === primary.description, "最初のdescriptionが完全にround-tripしません");
  assertCustomField(primary, facts.fields.threadId.id, threadId);
  assertCustomField(primary, facts.fields.intentId.id, createIntentId);
  assertCustomField(primary, facts.fields.requestHash.id, createRequestHash);
  const recoveredSeed = parseCarrier(primary.description, markerNames.recovery);
  assert(recoveredSeed?.threadId === threadId && recoveredSeed?.intentId === createIntentId &&
    recoveredSeed?.requestHash === createRequestHash, "最初のrecovery seedが不正です");
  evidence.firstThreadWrite.directReadRoundtrip = true;

  const providerBinding = {
    profileId,
    installationId: `backlog:${facts.space.spaceKey}`,
    objectId: String(primary.id)
  };
  const signedEnvelope = await codec.signEnvelope({
    schemaVersion: "2",
    threadId,
    intentId: createIntentId,
    requestHash: createRequestHash,
    providerBinding,
    scope: {
      workspace: projectKey,
      resource,
      application,
      environment
    },
    createdBy: { participantId },
    createdAt: new Date().toISOString()
  });
  const boundDescription = `${carrier(issueBody, markerNames.recovery, recoverySeed)}\n\n${block(markerNames.envelope, signedEnvelope)}`;
  await apiJson(`/api/v2/issues/${encodeURIComponent(String(primary.id))}`, {
    method: "PATCH",
    form: formData({ description: boundDescription })
  });
  const boundIssue = await apiJson(`/api/v2/issues/${encodeURIComponent(String(primary.id))}`);
  const envelopeVerification = await codec.verifyEnvelope(
    parseCarrier(boundIssue.description, markerNames.envelope),
    providerBinding
  );
  assert(envelopeVerification.valid, "provider objectへ束縛したEnvelopeを検証できません");
  evidence.firstThreadWrite.signedEnvelopeBoundAfterProviderIdentityResolution = true;

  const duplicateIntentId = randomUUID();
  const duplicateHash = calculateFeedbackCommandHash({ operation: "feedback:create-duplicate", threadId, runId });
  const duplicateSummary = `${summaryPrefix} duplicate`;
  await createIssueAndDiscardResponse(facts, {
    summary: duplicateSummary,
    description: carrier("重複候補。削除対象。", markerNames.recovery, {
      schemaVersion: "2",
      threadId,
      intentId: duplicateIntentId,
      requestHash: duplicateHash
    }),
    threadId,
    intentId: duplicateIntentId,
    requestHash: duplicateHash
  });
  const duplicateCandidates = await waitForExactCandidateCount(facts, threadId, 2);
  for (const issue of duplicateCandidates) cleanupIssueIds.add(String(issue.id));
  evidence.threadLookup.multipleExactHitsDecision = "repair_required";
  const duplicate = duplicateCandidates.find((issue) => customFieldValue(issue, facts.fields.intentId.id) === duplicateIntentId);
  assert(duplicate, "重複候補をintentIdでcleanup対象へ限定できません");
  await deleteIssue(duplicate.id);
  cleanupIssueIds.delete(String(duplicate.id));
  await waitForExactCandidateCount(facts, threadId, 1);

  const unusedCommentIntentId = randomUUID();
  const noMarkerComments = await listComments(primary.id);
  assert(!noMarkerComments.some((comment) => parseCarrier(comment.content, markerNames.message)?.intentId === unusedCommentIntentId),
    "未使用intentIdのcomment markerが存在します");
  evidence.comments.zeroMarkerHitsDecision = "pending";

  const reply = await createMessageMarker({
    codec,
    threadId,
    providerBinding,
    participantId,
    body: "Backlog Stage A reply",
    eventKind: "reply"
  });
  await addCommentAndDiscardResponse(primary.id, carrier(reply.body, markerNames.message, reply.marker));
  evidence.comments.replyBodyAndMarkerSingleRequest = true;
  await waitForVerifiedComment(primary.id, markerNames.message, reply.marker.intentId, async (content) => {
    const marker = parseCarrier(content, markerNames.message);
    const verification = await codec.verifyMessageMarker(marker, providerBinding);
    return verification.valid && visibleBody(content) === reply.body &&
      marker.bodyHash === calculateFeedbackCommandHash({ body: reply.body });
  });
  evidence.comments.replyRecoveredAfterResponseLoss = true;

  const duplicateComment = await apiJson(
    `/api/v2/issues/${encodeURIComponent(String(primary.id))}/comments`,
    { method: "POST", form: formData({ content: carrier(reply.body, markerNames.message, reply.marker) }) }
  );
  await waitForCommentMarkerCount(primary.id, markerNames.message, reply.marker.intentId, 2);
  evidence.comments.multipleMarkerHitsDecision = "repair_required";
  await deleteComment(primary.id, duplicateComment.id);
  await waitForCommentMarkerCount(primary.id, markerNames.message, reply.marker.intentId, 1);

  const revision = await createMessageMarker({
    codec,
    threadId,
    providerBinding,
    participantId,
    messageId: reply.marker.messageId,
    expectedRevisionId: reply.marker.messageId,
    body: "Backlog Stage A revised reply",
    eventKind: "revision"
  });
  await addCommentAndDiscardResponse(primary.id, carrier(revision.body, markerNames.message, revision.marker));
  evidence.comments.revisionAppendOnly = true;
  await waitForVerifiedComment(primary.id, markerNames.message, revision.marker.intentId, async (content) => {
    const marker = parseCarrier(content, markerNames.message);
    const verification = await codec.verifyMessageMarker(marker, providerBinding);
    return verification.valid && visibleBody(content) === revision.body &&
      marker.eventKind === "revision" && marker.expectedRevisionId === reply.marker.messageId;
  });
  evidence.comments.revisionRecoveredAfterResponseLoss = true;

  const discardedBytes = new TextEncoder().encode(`feedback backlog discarded upload ${runId}\n`);
  const discardedName = `feedback-stage-a-discarded-${runId}.txt`;
  const discardedUpload = await uploadTemporaryAttachment(discardedName, discardedBytes, "text/plain");
  evidence.attachment.initialUploadResponseDiscarded = true;
  evidence.attachment.initialUploadAutomaticRetry = false;
  // Connectorからは失われたIDを、test harnessだけがcleanup目的で既存issueへattachする。
  await apiJson(`/api/v2/issues/${encodeURIComponent(String(primary.id))}/comments`, {
    method: "POST",
    form: commentForm("Stage A discarded upload cleanup carrier", discardedUpload.id)
  });
  await waitForIssueAttachment(primary.id, discardedName, discardedBytes.byteLength);
  evidence.attachment.discardedUploadAttachedByCleanupHarness = true;

  const attachmentBytes = new TextEncoder().encode(`feedback backlog stage-a ${runId}\n`);
  const attachmentContentHash = sha256(attachmentBytes);
  const attachmentName = `feedback-stage-a-${runId}.txt`;
  const temporaryAttachment = await uploadTemporaryAttachment(attachmentName, attachmentBytes, "text/plain");
  evidence.attachment.temporaryUploadSucceeded = true;
  const attachmentId = randomUUID();
  const attachmentIntentId = randomUUID();
  const attachmentRequestHash = calculateFeedbackCommandHash({
    operation: "feedback:attachment",
    attachmentId,
    messageId: reply.marker.messageId,
    filename: attachmentName,
    sizeBytes: attachmentBytes.byteLength,
    contentHash: attachmentContentHash
  });
  const attachmentMarker = await codec.signAttachmentMarker({
    schemaVersion: "2",
    threadId,
    messageId: reply.marker.messageId,
    attachmentId,
    intentId: attachmentIntentId,
    requestHash: attachmentRequestHash,
    providerBinding,
    providerAttachmentId: String(temporaryAttachment.id),
    filename: attachmentName,
    contentType: "text/plain",
    sizeBytes: attachmentBytes.byteLength,
    contentHash: attachmentContentHash,
    createdAt: new Date().toISOString()
  });
  await addCommentAndDiscardResponse(
    primary.id,
    carrier("Feedback attachment metadata", markerNames.attachment, attachmentMarker),
    temporaryAttachment.id
  );
  evidence.attachment.metadataAndAttachSingleCommentRequest = true;
  await waitForVerifiedComment(primary.id, markerNames.attachment, attachmentIntentId, async (content) => {
    const marker = parseCarrier(content, markerNames.attachment);
    const verification = await codec.verifyAttachmentMarker(marker, providerBinding);
    return verification.valid && marker.providerAttachmentId === String(temporaryAttachment.id);
  });
  evidence.attachment.finalCommentRecoveredAfterResponseLoss = true;

  const finalAttachment = await waitForIssueAttachment(primary.id, attachmentName, attachmentBytes.byteLength);
  evidence.attachment.temporaryAndFinalProviderIdEqual =
    String(finalAttachment.id) === String(temporaryAttachment.id);
  const downloaded = await apiBytes(
    `/api/v2/issues/${encodeURIComponent(String(primary.id))}/attachments/${encodeURIComponent(String(finalAttachment.id))}`
  );
  assert(sha256(downloaded) === attachmentContentHash, "downloadしたattachmentのhashが一致しません");
  evidence.attachment.binaryHashRoundtrip = true;
  evidence.attachment.capabilityClassification = evidence.attachment.temporaryAndFinalProviderIdEqual
    ? "best-effort"
    : "unsupported";

  const reconstruction = await spawnReconstruction({
    signingSecret,
    expected: {
      threadId,
      createIntentId,
      replyIntentId: reply.marker.intentId,
      revisionIntentId: revision.marker.intentId,
      attachmentIntentId
    }
  });
  evidence.restartReconstruction.separateProcess = reconstruction.pid !== process.pid;
  evidence.restartReconstruction.threadEnvelopeVerified = reconstruction.threadEnvelopeVerified;
  evidence.restartReconstruction.replyVerified = reconstruction.replyVerified;
  evidence.restartReconstruction.revisionVerified = reconstruction.revisionVerified;
  evidence.restartReconstruction.attachmentVerified = reconstruction.attachmentVerified;
  assert(Object.values(evidence.restartReconstruction).every((value) => value === true || value === false) &&
    evidence.restartReconstruction.separateProcess && evidence.restartReconstruction.threadEnvelopeVerified &&
    evidence.restartReconstruction.replyVerified && evidence.restartReconstruction.revisionVerified &&
    (evidence.restartReconstruction.attachmentVerified ||
      evidence.attachment.capabilityClassification === "unsupported"), "別process再構築が完了しませんでした");
  evidence.hardGate = {
    status: "passed",
    passed: true,
    recoverableOperations: ["create", "reply", "revision"],
    unsupportedOperations: evidence.attachment.capabilityClassification === "unsupported"
      ? ["attachment-read", "attachment-upload"]
      : []
  };
} finally {
  const discovered = facts ? await findRunOwnedIssues(facts.project.id, runId).catch(() => []) : [];
  for (const issue of discovered) cleanupIssueIds.add(String(issue.id));
  const failures = [];
  for (const issueId of cleanupIssueIds) {
    try {
      await deleteIssue(issueId);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  const remaining = facts ? await findRunOwnedIssues(facts.project.id, runId).catch(() => [{ id: "unknown" }]) : [];
  evidence.cleanup = failures.length === 0 && remaining.length === 0
    ? "deleted-all-run-owned-issues"
    : "failed-to-delete-all-run-owned-issues";
}

if (evidence.cleanup !== "deleted-all-run-owned-issues") {
  throw new Error(`Backlog Stage A cleanupに失敗しました: ${evidence.cleanup}`);
}
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

async function reconstructInFreshProcess() {
  const input = JSON.parse(required("BACKLOG_STAGE_A_RECONSTRUCT_INPUT"));
  const secret = Buffer.from(required("BACKLOG_STAGE_A_SIGNING_SECRET"), "base64url");
  assert(secret.byteLength === 32, "再構築processの署名鍵が不正です");
  assert(!("issueId" in input) && !("issueKey" in input) && !("commentId" in input),
    "再構築processへprovider IDを渡してはいけません");
  const childCodec = feedbackCodec(secret);
  const childFacts = await discoverFacts();
  const candidates = await findExactThreadCandidates(childFacts, input.threadId);
  assert(candidates.exact.length === 1, "別processでthreadを一意に再解決できません");
  const issue = await apiJson(`/api/v2/issues/${encodeURIComponent(String(candidates.exact[0].id))}`);
  const providerBinding = {
    profileId,
    installationId: `backlog:${childFacts.space.spaceKey}`,
    objectId: String(issue.id)
  };
  const envelope = parseCarrier(issue.description, markerNames.envelope);
  const envelopeVerification = await childCodec.verifyEnvelope(envelope, providerBinding);
  assert(envelopeVerification.valid && envelope.threadId === input.threadId &&
    envelope.intentId === input.createIntentId, "別processでEnvelopeを検証できません");

  const comments = await listComments(issue.id);
  const verifiedMessages = new Map();
  let attachmentVerified = false;
  for (const comment of comments) {
    const message = parseCarrier(comment.content, markerNames.message);
    if (message) {
      const verification = await childCodec.verifyMessageMarker(message, providerBinding);
      if (verification.valid && message.bodyHash === calculateFeedbackCommandHash({ body: visibleBody(comment.content) })) {
        verifiedMessages.set(message.intentId, message);
      }
    }
    const attachment = parseCarrier(comment.content, markerNames.attachment);
    if (attachment?.intentId === input.attachmentIntentId) {
      const verification = await childCodec.verifyAttachmentMarker(attachment, providerBinding);
      if (verification.valid) {
        const attachments = await apiJson(`/api/v2/issues/${encodeURIComponent(String(issue.id))}/attachments`);
        const matching = attachments.find((item) => String(item.id) === attachment.providerAttachmentId);
        if (matching) {
          const bytes = await apiBytes(
            `/api/v2/issues/${encodeURIComponent(String(issue.id))}/attachments/${encodeURIComponent(String(matching.id))}`
          );
          attachmentVerified = sha256(bytes) === attachment.contentHash && bytes.byteLength === attachment.sizeBytes;
        }
      }
    }
  }
  const reply = verifiedMessages.get(input.replyIntentId);
  const revision = verifiedMessages.get(input.revisionIntentId);
  process.stdout.write(`${JSON.stringify({
    pid: process.pid,
    threadEnvelopeVerified: true,
    replyVerified: reply?.eventKind === "reply",
    revisionVerified: revision?.eventKind === "revision" && revision?.messageId === reply?.messageId,
    attachmentVerified
  })}\n`);
}

async function discoverFacts() {
  const [user, space, projects] = await Promise.all([
    apiJson("/api/v2/users/myself"),
    apiJson("/api/v2/space"),
    apiJson("/api/v2/projects")
  ]);
  const project = projects.find((candidate) => candidate.projectKey === projectKey && candidate.archived !== true);
  assert(project, "指定projectが見つからないかarchive済みです");
  const [customFields, issueTypes, priorities] = await Promise.all([
    apiJson(`/api/v2/projects/${encodeURIComponent(projectKey)}/customFields`),
    apiJson(`/api/v2/projects/${encodeURIComponent(projectKey)}/issueTypes`),
    apiJson("/api/v2/priorities")
  ]);
  const fields = {
    threadId: uniqueTextField(customFields, "feedback.threadId"),
    intentId: uniqueTextField(customFields, "feedback.intentId"),
    requestHash: uniqueTextField(customFields, "feedback.requestHash")
  };
  const issueType = issueTypes.find((candidate) => candidate.name === "タスク") ?? issueTypes[0];
  const priority = priorities.find((candidate) => candidate.id === 3) ?? priorities[0];
  assert(issueType && priority, "作成可能なissue typeまたはpriorityがありません");
  return { user, space, project, fields, issueType, priority };
}

async function createIssueAndDiscardResponse(factsValue, input) {
  const form = formData({
    projectId: factsValue.project.id,
    summary: input.summary,
    description: input.description,
    issueTypeId: factsValue.issueType.id,
    priorityId: factsValue.priority.id,
    [`customField_${factsValue.fields.threadId.id}`]: input.threadId,
    [`customField_${factsValue.fields.intentId.id}`]: input.intentId,
    [`customField_${factsValue.fields.requestHash.id}`]: input.requestHash
  });
  const created = await apiJson("/api/v2/issues", { method: "POST", form });
  assert(Number.isInteger(created?.id), "作成issueのcleanup用provider IDが不正です");
  // provider IDはcleanup harnessだけが保持し、機能経路はthreadId検索だけで回復する。
  cleanupIssueIds.add(String(created.id));
}

async function findExactThreadCandidates(factsValue, targetThreadId) {
  const all = [];
  let offset = 0;
  for (;;) {
    const query = new URLSearchParams();
    query.append("projectId[]", String(factsValue.project.id));
    query.set(`customField_${factsValue.fields.threadId.id}`, targetThreadId);
    query.set("sort", "id");
    query.set("order", "asc");
    query.set("count", "100");
    query.set("offset", String(offset));
    const page = await apiJson(`/api/v2/issues?${query.toString()}`);
    assert(Array.isArray(page), "issue検索responseが配列ではありません");
    all.push(...page);
    if (page.length < 100) break;
    offset += page.length;
    assert(offset <= 10_000, "issue検索paginationが上限を超えました");
  }
  return {
    providerHits: all.length,
    exact: all.filter((issue) => customFieldValue(issue, factsValue.fields.threadId.id) === targetThreadId)
  };
}

async function waitForExactCandidateCount(factsValue, targetThreadId, count) {
  const deadline = Date.now() + 60_000;
  do {
    const result = await findExactThreadCandidates(factsValue, targetThreadId);
    if (result.exact.length === count) return count === 1 ? result.exact[0] : result.exact;
    if (result.exact.length > count) throw new Error(`thread検索が期待件数${count}を超えました`);
    await delay(1_000);
  } while (Date.now() < deadline);
  throw new Error(`thread検索が60秒以内に${count}件になりませんでした`);
}

async function createMessageMarker(input) {
  const intentId = randomUUID();
  const messageId = input.messageId ?? randomUUID();
  const eventId = input.eventKind === "revision" ? randomUUID() : messageId;
  const requestHash = calculateFeedbackCommandHash({
    operation: input.eventKind === "reply" ? "feedback:reply" : "feedback:revision",
    threadId: input.threadId,
    messageId,
    eventId,
    body: input.body
  });
  const payload = {
    schemaVersion: "2",
    threadId: input.threadId,
    eventId,
    eventKind: input.eventKind,
    messageId,
    ...(input.expectedRevisionId ? { expectedRevisionId: input.expectedRevisionId } : {}),
    intentId,
    requestHash,
    participantId: input.participantId,
    bodyHash: calculateFeedbackCommandHash({ body: input.body }),
    providerBinding: input.providerBinding,
    createdAt: new Date().toISOString()
  };
  return { body: input.body, marker: await input.codec.signMessageMarker(payload) };
}

async function addCommentAndDiscardResponse(issueId, content, attachmentId) {
  const form = commentForm(content, attachmentId);
  await apiJson(`/api/v2/issues/${encodeURIComponent(String(issueId))}/comments`, { method: "POST", form });
  // comment IDを保持せず、provider本文の署名markerで回収する。
}

async function waitForCommentMarkerCount(issueId, markerName, intentId, count) {
  const deadline = Date.now() + 60_000;
  do {
    const comments = await listComments(issueId);
    const matching = comments.filter((comment) => parseCarrier(comment.content, markerName)?.intentId === intentId);
    if (matching.length === count) return matching;
    if (matching.length > count) throw new Error(`comment markerが期待件数${count}を超えました`);
    await delay(1_000);
  } while (Date.now() < deadline);
  throw new Error(`comment markerが60秒以内に${count}件になりませんでした`);
}

async function deleteComment(issueId, commentId) {
  await apiJson(
    `/api/v2/issues/${encodeURIComponent(String(issueId))}/comments/${encodeURIComponent(String(commentId))}`,
    { method: "DELETE" }
  );
}

async function waitForVerifiedComment(issueId, markerName, intentId, verify) {
  const deadline = Date.now() + 60_000;
  do {
    const comments = await listComments(issueId);
    const matching = comments.filter((comment) => parseCarrier(comment.content, markerName)?.intentId === intentId);
    if (matching.length > 1) throw new Error("同じintentIdのcommentが複数あります");
    if (matching.length === 1 && await verify(matching[0].content)) return matching[0];
    await delay(1_000);
  } while (Date.now() < deadline);
  throw new Error("comment markerを60秒以内に回収できませんでした");
}

async function listComments(issueId) {
  const comments = [];
  let minId;
  for (;;) {
    const query = new URLSearchParams({ count: "100", order: "asc" });
    if (minId !== undefined) query.set("minId", String(minId));
    const page = await apiJson(`/api/v2/issues/${encodeURIComponent(String(issueId))}/comments?${query.toString()}`);
    assert(Array.isArray(page), "comment list responseが配列ではありません");
    const previousSize = comments.length;
    for (const comment of page) {
      if (!comments.some((existing) => String(existing.id) === String(comment.id))) comments.push(comment);
    }
    if (page.length < 100) break;
    minId = page.at(-1).id;
    assert(comments.length > previousSize && comments.length <= 10_000, "comment paginationが進みません");
  }
  return comments;
}

async function uploadTemporaryAttachment(filename, bytes, contentType) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: contentType }), filename);
  const result = await apiJson("/api/v2/space/attachment", { method: "POST", form });
  assert(result && (typeof result.id === "number" || typeof result.id === "string"),
    "temporary attachment responseが不正です");
  return result;
}

async function waitForIssueAttachment(issueId, expectedName, expectedSize) {
  const deadline = Date.now() + 60_000;
  do {
    const attachments = await apiJson(`/api/v2/issues/${encodeURIComponent(String(issueId))}/attachments`);
    assert(Array.isArray(attachments), "issue attachment responseが配列ではありません");
    const matching = attachments.filter((item) => item.name === expectedName && item.size === expectedSize);
    if (matching.length > 1) throw new Error("同名同sizeのissue attachmentが複数あります");
    if (matching.length === 1) return matching[0];
    await delay(1_000);
  } while (Date.now() < deadline);
  throw new Error("issue attachmentを60秒以内に確認できませんでした");
}

async function spawnReconstruction(input) {
  const childInput = {
    threadId: input.expected.threadId,
    createIntentId: input.expected.createIntentId,
    replyIntentId: input.expected.replyIntentId,
    revisionIntentId: input.expected.revisionIntentId,
    attachmentIntentId: input.expected.attachmentIntentId
  };
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "--reconstruct"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BACKLOG_STAGE_A_RECONSTRUCT_INPUT: JSON.stringify(childInput),
        BACKLOG_STAGE_A_SIGNING_SECRET: Buffer.from(input.signingSecret).toString("base64url")
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve(stdout)
      : reject(new Error(`別process再構築が終了code ${code}で失敗しました: ${stderr.slice(0, 500)}`)));
  });
  return JSON.parse(output);
}

async function findRunOwnedIssues(projectId, identifier) {
  const query = new URLSearchParams();
  query.append("projectId[]", String(projectId));
  query.set("keyword", identifier);
  query.set("count", "100");
  const issues = await apiJson(`/api/v2/issues?${query.toString()}`);
  return issues.filter((issue) => typeof issue.summary === "string" && issue.summary.startsWith(`[feedback-stage-a-live:${identifier}]`));
}

async function deleteIssue(issueId) {
  await apiJson(`/api/v2/issues/${encodeURIComponent(String(issueId))}`, { method: "DELETE", empty: true });
}

function commentForm(content, attachmentId) {
  const form = formData({ content });
  if (attachmentId !== undefined) form.append("attachmentId[]", String(attachmentId));
  return form;
}

async function apiJson(path, options = {}) {
  const response = await backlogFetch(path, options);
  if (options.empty || response.status === 204) return null;
  return response.json();
}

async function apiBytes(path, options = {}) {
  const response = await backlogFetch(path, options);
  return new Uint8Array(await response.arrayBuffer());
}

async function backlogFetch(path, options) {
  const waitMilliseconds = Math.max(0, 1_050 - (Date.now() - lastRequestAt));
  if (waitMilliseconds > 0) await delay(waitMilliseconds);
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  headers.set("Backlog-API-Key", apiKey);
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.form,
    redirect: "error"
  });
  lastRequestAt = Date.now();
  if (!response.ok) {
    let code = "unknown";
    try {
      const error = await response.json();
      code = Array.isArray(error?.errors) ? String(error.errors[0]?.code ?? "unknown") : "unknown";
    } catch {
      // provider本文やtenant情報をerrorへ含めない。
    }
    throw new Error(`Backlog API ${options.method ?? "GET"} ${new URL(path, baseUrl).pathname}が失敗しました: status=${response.status}, code=${code}`);
  }
  return response;
}

function feedbackCodec(secret) {
  return createFeedbackEnvelopeCodec([{
    kid: "backlog-stage-a-ephemeral",
    secret: Uint8Array.from(secret),
    state: "active"
  }]);
}

function uniqueTextField(fields, name) {
  const matches = fields.filter((field) => field.name === name);
  assert(matches.length === 1, `${name} custom fieldは1件必要です`);
  const field = matches[0];
  assert(field.typeId === 1 && field.required === false, `${name}は任意Text custom fieldである必要があります`);
  return field;
}

function customFieldValue(issue, fieldId) {
  return issue.customFields?.find((field) => String(field.id) === String(fieldId))?.value;
}

function assertCustomField(issue, fieldId, expected) {
  assert(customFieldValue(issue, fieldId) === expected, "custom fieldが完全にround-tripしません");
}

function block(name, value) {
  return `[${name}]\n${JSON.stringify(value)}\n[/${name}]`;
}

function carrier(body, name, value) {
  return `${body}\n\n${block(name, value)}`;
}

function parseCarrier(content, name) {
  if (typeof content !== "string") return null;
  const startToken = `[${name}]\n`;
  const endToken = `\n[/${name}]`;
  const start = content.indexOf(startToken);
  if (start < 0) return null;
  const valueStart = start + startToken.length;
  const end = content.indexOf(endToken, valueStart);
  if (end < 0 || content.indexOf(startToken, valueStart) >= 0) return null;
  try {
    return JSON.parse(content.slice(valueStart, end));
  } catch {
    return null;
  }
}

function visibleBody(content) {
  if (typeof content !== "string") return "";
  const positions = Object.values(markerNames)
    .map((name) => content.indexOf(`\n\n[${name}]\n`))
    .filter((position) => position >= 0);
  return positions.length === 0 ? content : content.slice(0, Math.min(...positions));
}

function formData(values) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) form.append(key, String(value));
  return form;
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function implementationDigest() {
  const files = [
    "contracts/feedback/schemas/feedback-envelope.schema.json",
    "contracts/feedback/schemas/feedback-message-marker.schema.json",
    "contracts/feedback/schemas/feedback-attachment-marker.schema.json",
    "packages/feedback-envelope/src/index.ts",
    "scripts/run-feedback-backlog-stage-a.mjs"
  ];
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(readFileSync(file)).update("\0");
  return `sha256:${hash.digest("hex")}`;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name}がありません`);
  return value;
}

function backlogOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Backlog base URLはcredentialを含まないHTTPS originである必要があります");
  }
  return url.origin;
}

function stableProjectKey(value) {
  if (!/^[A-Z][A-Z0-9_]{1,127}$/u.test(value)) throw new Error("Backlog project keyが不正です");
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
