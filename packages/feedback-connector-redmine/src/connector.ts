import { createHash } from "node:crypto";
import type {
  FeedbackAppendRevisionCommandV2,
  FeedbackAttachmentCommandResultV2,
  FeedbackCapabilitiesV2,
  FeedbackCreateThreadCommandV2,
  FeedbackIntentRecoveryResultV2,
  FeedbackMessageCommandResultV2,
  FeedbackReplyCommandV2,
  FeedbackThreadCommandResultV2,
  FeedbackUploadAttachmentCommandV2
} from "@geibee/feedback-contracts/v2";
import type { FeedbackAttachmentMarkerV2, FeedbackMessageMarkerV2, FeedbackProjectionV2 } from "@geibee/feedback-contracts/v2/server";
import {
  FeedbackConnectorProblem,
  type FeedbackIntentRecoveryResultFor,
  type FeedbackProjectionCandidate,
  type FeedbackRecoverableOperation,
  type FeedbackRepositoryOptions,
  type FeedbackRepositoryPort,
  type FeedbackRepositoryScope
} from "@geibee/feedback-connector-sdk";
import { calculateFeedbackCommandHash, type FeedbackEnvelopeCodecPort } from "@geibee/feedback-envelope";
import { redmineContractFixture } from "./contract-fixture.js";
import { deriveRedmineStableId } from "./legacy.js";
import { mapRedmineIssue, redmineProjectionCandidate } from "./mapper.js";
import { buildDualWriteRedmineNote, buildRedmineAttachmentMappingNote, parseRedmineMessageNote } from "./markers.js";
import { assertFeedbackRedmineProfile } from "./provisioning.js";
import type {
  FeedbackRedmineProfileV2,
  FeedbackRedmineTransportPort,
  RedmineIssueRaw,
  RedmineIssueSummaryRaw
} from "./redmine-types.js";

const pageSize = 100;

export function createFeedbackRedmineConnector(input: {
  profile: FeedbackRedmineProfileV2;
  transport: FeedbackRedmineTransportPort;
  envelopeCodec: FeedbackEnvelopeCodecPort;
  now?: () => string;
}): FeedbackRepositoryPort {
  assertFeedbackRedmineProfile(input.profile);
  const profile = Object.freeze({ ...input.profile, customFieldIds: { ...input.profile.customFieldIds } });
  const transport = input.transport;
  const codec = input.envelopeCodec;
  const now = input.now ?? (() => new Date().toISOString());

  const repository: FeedbackRepositoryPort = {
    async getCapabilities() {
      return capabilities(profile);
    },

    async listWorkspaces(profileId, cursor) {
      assertProfile(profile, profileId);
      if (cursor !== undefined && cursor !== "") throw invalidCursor();
      return { items: [{ workspaceId: profile.workspaceId, displayName: profile.workspaceDisplayName }], nextCursor: null };
    },

    async listResources(query, options) {
      assertProfile(profile, query.profileId);
      assertWorkspace(profile, query.workspaceId);
      const offset = parseCursor(query.cursor, resourceFingerprint(profile, query.query));
      const result = await transport.searchIssues({
        projectId: profile.projectId,
        customFieldFilters: baseFilters(profile),
        offset,
        limit: pageSize,
        order: "updated_desc"
      }, options?.signal);
      const keys = new Set<string>();
      for (const issue of result.issues) {
        const value = customFieldText(issue, profile.customFieldIds.hostResourceKey);
        if (value && (!query.query || value.includes(query.query))) keys.add(value);
      }
      const nextOffset = result.offset + result.issues.length;
      return {
        items: [...keys].sort().map((key) => ({ resource: { kind: "record", key }, displayName: key })),
        nextCursor: nextOffset < result.totalCount ? cursor(nextOffset, resourceFingerprint(profile, query.query)) : null
      };
    },

    async findThreadCandidates(query, options) {
      assertScope(profile, query);
      const fingerprint = threadFingerprint(query);
      const offset = parseCursor(query.cursor, fingerprint);
      const result = await transport.searchIssues({
        projectId: profile.projectId,
        customFieldFilters: scopeFilters(profile, query),
        offset,
        limit: pageSize,
        order: query.order ?? "updated_desc"
      }, options?.signal);
      const candidates = result.issues
        .map((issue) => redmineProjectionCandidate(issue, profile, query.resource))
        .filter((candidate): candidate is FeedbackProjectionCandidate => candidate !== null)
        .filter((candidate) => projectionMatches(candidate.projection, query));
      const nextOffset = result.offset + result.issues.length;
      return { candidates, nextCursor: nextOffset < result.totalCount ? cursor(nextOffset, fingerprint) : null };
    },

    async findThreadCandidatesById(query, options) {
      assertScope(profile, query);
      const issues = await searchByThread(query, options);
      return issues
        .map((issue) => redmineProjectionCandidate(issue, profile, query.resource))
        .filter((candidate): candidate is FeedbackProjectionCandidate => candidate !== null)
        .filter((candidate) => candidate.projection.threadId === query.threadId && projectionMatches(candidate.projection, query));
    },

    async readCandidate(candidate, options) {
      if (candidate.providerRef.providerKey !== "redmine" || !/^[1-9][0-9]*$/u.test(candidate.providerRef.objectId)) {
        throw integrity("Redmine candidate provider bindingが不正です");
      }
      const issue = await transport.getIssue(Number(candidate.providerRef.objectId), options?.signal);
      const scope = scopeFromProjection(candidate.projection, profile);
      const mapped = await mapRedmineIssue(issue, profile, scope, codec);
      if (mapped.thread.threadId !== candidate.projection.threadId || !projectionMatches(candidate.projection, scope)) {
        throw integrity("Redmine projectionとprovider rereadが一致しません");
      }
      return mapped;
    },

    async createThread(query, options) {
      assertScope(profile, query);
      assertCreateCommand(query.command, query);
      const createScope = { ...query, threadId: query.command.threadId };
      const existing = await recoverCreate(createScope, query.command.intentId, query.command.requestHash, options, true);
      if (existing.state === "completed" || existing.state === "repair_required") return existing;
      const issue = createIssueInput(profile, query.command);
      try {
        const created = await transport.createIssue(issue, options?.signal);
        await provisionCreatedIssue(created.issueId, query, query.command, options);
        const mapped = await mapRedmineIssue(await transport.getIssue(created.issueId, options?.signal), profile, query, codec);
        return { disposition: "created", intentId: query.command.intentId, thread: mapped.thread };
      } catch (error) {
        if (!couldBeUnknownProviderResult(error)) throw normalizeProviderError(error);
        const recovered = await recoverCreate(createScope, query.command.intentId, query.command.requestHash, options, true);
        if (recovered.state !== "completed") return recovered;
        const mapped = await readUniqueThread(createScope, options);
        return { disposition: "recovered", intentId: query.command.intentId, thread: mapped.thread };
      }
    },

    async reply(query, options) {
      assertScope(profile, query);
      const resolved = await resolveIssue(query, options);
      const prior = await scanIntent(resolved.issue, query.threadId, query.command.intentId, query.command.requestHash, "feedback:reply");
      if (prior.kind === "one") return messageResult(resolved.issue, query, query.command.intentId, prior.stableResultId, "already_applied", options);
      if (prior.kind === "many") return repair(query.command.intentId, "feedback:reply", "同じreply intentが複数あります", "recover-only");
      const marker = await signReplyMarker(resolved.issueId, query.threadId, query.command, profile, codec, now());
      const notes = buildDualWriteRedmineNote(query.command.body, {
        kind: "reply",
        messageId: query.command.messageId,
        participantId: profile.participantId,
        participantName: profile.participantDisplayName,
        version: 1,
        intentId: query.command.intentId,
        signature: marker.signature.value,
        feedbackV2: marker
      });
      try {
        await transport.updateIssue(resolved.issueId, { notes }, options?.signal);
      } catch (error) {
        if (!couldBeUnknownProviderResult(error)) throw normalizeProviderError(error);
        return recoverMessageAfterUnknown(query, "feedback:reply", query.command.intentId, query.command.requestHash, options);
      }
      return messageResult(await transport.getIssue(resolved.issueId, options?.signal), query, query.command.intentId,
        query.command.messageId, "created", options);
    },

    async appendRevision(query, options) {
      assertScope(profile, query);
      const resolved = await resolveIssue(query, options);
      const prior = await scanIntent(resolved.issue, query.threadId, query.command.intentId, query.command.requestHash, "feedback:revise");
      if (prior.kind === "one") return messageResult(resolved.issue, query, query.command.intentId, query.messageId, "already_applied", options);
      if (prior.kind === "many") return repair(query.command.intentId, "feedback:revise", "同じrevision intentが複数あります", "do-not-write");
      const mapped = await mapRedmineIssue(resolved.issue, profile, query, codec);
      const current = mapped.thread.messages.find((message) => message.messageId === query.messageId);
      if (!current) throw notFound("編集対象messageがありません");
      if (current.revisions[current.revisions.length - 1]?.revisionId !== query.command.expectedRevisionId) {
        throw new FeedbackConnectorProblem({ code: "feedback.conflict", status: 409, retryable: false, message: "expected revisionが現在値と一致しません" });
      }
      const marker = await signRevisionMarker(resolved.issueId, query.threadId, query.messageId, query.command, profile, codec, now());
      const notes = buildDualWriteRedmineNote(query.command.body, {
        kind: "edit",
        messageId: query.messageId,
        participantId: profile.participantId,
        participantName: profile.participantDisplayName,
        version: current.revisions.length + 1,
        intentId: query.command.intentId,
        signature: marker.signature.value,
        feedbackV2: marker
      });
      try {
        await transport.updateIssue(resolved.issueId, { notes }, options?.signal);
      } catch (error) {
        if (!couldBeUnknownProviderResult(error)) throw normalizeProviderError(error);
        const outcome = await scanIntent(await transport.getIssue(resolved.issueId, options?.signal), query.threadId,
          query.command.intentId, query.command.requestHash, "feedback:revise");
        if (outcome.kind === "one") return messageResult(await transport.getIssue(resolved.issueId, options?.signal), query,
          query.command.intentId, query.messageId, "recovered", options);
        return repair(query.command.intentId, "feedback:revise", "revision writeの結果が不明です", "do-not-write");
      }
      return messageResult(await transport.getIssue(resolved.issueId, options?.signal), query, query.command.intentId,
        query.messageId, "created", options);
    },

    async recoverIntent(query, options) {
      assertScope(profile, query);
      if (query.operation === "feedback:create") {
        return recoverCreate(query, query.intentId, query.requestHash, options, true);
      }
      const resolved = await resolveIssue(query, options);
      const outcome = await scanIntent(resolved.issue, query.threadId, query.intentId, query.requestHash, query.operation);
      if (outcome.kind === "one") return { intentId: query.intentId, state: "completed", operation: query.operation, stableResultId: outcome.stableResultId };
      if (outcome.kind === "many") return repair(query.intentId, query.operation, "同じintentのprovider eventが複数あります", "do-not-write");
      return query.operation === "feedback:attachment:upload"
        ? repair(query.intentId, query.operation, "attachment upload結果をproviderから一意に確認できません", "manual-confirmation")
        : pending(query.intentId, query.operation);
    },

    async uploadAttachment(query, options) {
      assertScope(profile, query);
      assertUpload(profile, query.command, query.source.sizeBytes);
      const resolved = await resolveIssue(query, options);
      const messageId = query.command.messageId ?? query.threadId;
      const beforeUpload = await mapRedmineIssue(resolved.issue, profile, query, codec);
      if (!beforeUpload.thread.messages.some((message) => message.messageId === messageId)) {
        throw notFound("attachment対象messageがありません");
      }
      const prior = await scanIntent(resolved.issue, query.threadId, query.command.intentId,
        query.command.requestHash, "feedback:attachment:upload");
      if (prior.kind === "one") return attachmentResult(resolved.issue, query, prior.stableResultId, "already_applied", options);
      if (prior.kind === "many") return repair(query.command.intentId, "feedback:attachment:upload", "同じattachment intentが複数あります", "manual-confirmation");
      let receipt: { token: string };
      try {
        // binary uploadはこの一回だけ。以降のerror pathからuploadへ戻らない。
        receipt = await transport.upload(query.source, {
          filename: query.command.filename,
          contentType: query.command.contentType,
          contentHash: query.command.contentHash
        }, options?.signal);
      } catch (error) {
        if (!couldBeUnknownProviderResult(error)) throw normalizeProviderError(error);
        return repair(query.command.intentId, "feedback:attachment:upload", "binary upload responseが不明です", "manual-confirmation");
      }
      try {
        await transport.updateIssue(resolved.issueId, {
          uploads: [{
            token: receipt.token,
            filename: query.command.filename,
            content_type: query.command.contentType,
            ...(query.command.messageId ? { description: query.command.messageId } : {})
          }]
        }, options?.signal);
        const attached = await transport.getIssue(resolved.issueId, options?.signal);
        const providerAttachmentId = uniqueNewAttachment(attached, query.command);
        const marker = await codec.signAttachmentMarker({
          schemaVersion: "2",
          threadId: query.threadId,
          messageId,
          attachmentId: query.command.attachmentId,
          intentId: query.command.intentId,
          requestHash: query.command.requestHash,
          providerBinding: binding(profile, resolved.issueId),
          providerAttachmentId,
          filename: query.command.filename,
          contentType: query.command.contentType,
          sizeBytes: query.command.sizeBytes,
          contentHash: query.command.contentHash,
          createdAt: now()
        });
        await transport.updateIssue(resolved.issueId, { notes: buildRedmineAttachmentMappingNote(marker) }, options?.signal);
        return attachmentResult(await transport.getIssue(resolved.issueId, options?.signal), query,
          query.command.attachmentId, "created", options);
      } catch (error) {
        void error;
        return repair(query.command.intentId, "feedback:attachment:upload", "attachment associationまたはmappingの結果が不明です", "manual-confirmation");
      }
    },

    async getAttachment(query, options) {
      assertScope(profile, query);
      const resolved = await resolveIssue(query, options);
      const mapped = await mapRedmineIssue(resolved.issue, profile, query, codec);
      const declared = mapped.thread.messages
        .flatMap((message) => message.attachments)
        .find((attachment) => attachment.attachmentId === query.attachmentId);
      if (!declared) throw notFound("attachmentがありません");
      if (declared.sizeBytes > profile.maximumAttachmentBytes) {
        throw new FeedbackConnectorProblem({
          code: "feedback.unsupported",
          status: 413,
          retryable: false,
          message: "Redmine attachmentがprofile上限を超えています"
        });
      }
      const attachmentBinding = providerAttachmentBinding(resolved.issue, query.threadId, query.attachmentId);
      if (!attachmentBinding) throw notFound("attachmentがありません");
      const downloaded = await transport.downloadAttachment(attachmentBinding.providerId, options?.signal);
      if (downloaded.filename !== declared.filename || downloaded.contentType !== declared.contentType ||
        downloaded.sizeBytes !== declared.sizeBytes || downloaded.sizeBytes > profile.maximumAttachmentBytes) {
        throw integrity("Redmine attachment download metadataがprovider metadataと一致しません");
      }
      const bytes = await collectDownload(downloaded.body, profile.maximumAttachmentBytes);
      if (bytes.byteLength !== declared.sizeBytes) {
        throw integrity("Redmine attachment stream sizeがprovider metadataと一致しません");
      }
      if (!attachmentBinding.marker) {
        return { ...downloaded, body: (async function* () { yield bytes; })() };
      }
      const marker = attachmentBinding.marker;
      const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (downloaded.filename !== marker.filename || downloaded.contentType !== marker.contentType ||
        downloaded.sizeBytes !== marker.sizeBytes || bytes.byteLength !== marker.sizeBytes || contentHash !== marker.contentHash) {
        throw integrity("Redmine attachment contentが署名済みmappingと一致しません");
      }
      return { ...downloaded, body: (async function* () { yield bytes; })() };
    }
  };

  async function provisionCreatedIssue(
    issueId: number,
    scope: FeedbackRepositoryScope,
    command: FeedbackCreateThreadCommandV2,
    options?: FeedbackRepositoryOptions
  ): Promise<void> {
    let created = await transport.getIssue(issueId, options?.signal);
    const createdAt = typeof created.created_on === "string" ? created.created_on : now();
    const envelope = await codec.signEnvelope({
      schemaVersion: "2",
      threadId: command.threadId,
      intentId: command.intentId,
      requestHash: command.requestHash,
      providerBinding: binding(profile, issueId),
      scope: {
        workspace: scope.workspaceId,
        resource: scope.resource,
        application: profile.applicationKey,
        environment: profile.environmentKey
      },
      createdBy: { participantId: profile.participantId },
      createdAt
    });
    const projection: FeedbackProjectionV2 = {
      schemaVersion: "2",
      threadId: command.threadId,
      intentId: command.intentId,
      requestHash: command.requestHash,
      profileId: profile.profileId,
      workspaceId: scope.workspaceId,
      resource: scope.resource
    };
    if (!customFieldText(created, profile.customFieldIds.envelope)) {
      await transport.updateIssue(issueId, {
        custom_fields: [{ id: profile.customFieldIds.envelope, value: JSON.stringify(envelope) }]
      }, options?.signal);
      created = await transport.getIssue(issueId, options?.signal);
    }
    // 既存Envelopeが不正ならprojectionを補修せずfail-closedにする。
    await mapRedmineIssue(created, profile, scope, codec);
    if (!customFieldText(created, profile.customFieldIds.projection)) {
      await transport.updateIssue(issueId, {
        custom_fields: [{ id: profile.customFieldIds.projection, value: JSON.stringify(projection) }]
      }, options?.signal);
    }
  }

  async function recoverCreate(
    scope: FeedbackRepositoryScope & { threadId: string },
    intentId: string,
    requestHash: string,
    options: FeedbackRepositoryOptions | undefined,
    repairSeed: boolean
  ): Promise<FeedbackIntentRecoveryResultFor<"feedback:create">> {
    const issues = await searchByThread(scope, options);
    if (issues.length === 0) return pending(intentId, "feedback:create");
    if (issues.length > 1) return repair(intentId, "feedback:create", "thread IDに複数のRedmine issueがあります", "do-not-write");
    const issue = await transport.getIssue(issues[0]!.id, options?.signal);
    assertSeed(issue, intentId, requestHash, profile);
    const envelopeValue = customFieldText(issue, profile.customFieldIds.envelope);
    const projectionValue = customFieldText(issue, profile.customFieldIds.projection);
    if ((!envelopeValue || !projectionValue) && repairSeed) await provisionCreatedIssue(issue.id, scope, {
      intentId,
      requestHash,
      threadId: scope.threadId,
      resource: scope.resource,
      title: typeof issue.subject === "string" ? issue.subject : "Feedback",
      body: typeof issue.description === "string" ? issue.description : "Feedback"
    }, options);
    if ((!envelopeValue || !projectionValue) && !repairSeed) return pending(intentId, "feedback:create");
    const mapped = await mapRedmineIssue(await transport.getIssue(issue.id, options?.signal), profile, scope, codec);
    if (mapped.thread.threadId !== scope.threadId || mapped.envelope?.intentId !== intentId ||
      mapped.envelope.requestHash !== requestHash) throw integrity("回収したRedmine Envelopeがcreate commandと一致しません");
    return { intentId, state: "completed", operation: "feedback:create", stableResultId: scope.threadId };
  }

  async function searchByThread(
    scope: FeedbackRepositoryScope & { threadId: string },
    options?: FeedbackRepositoryOptions
  ): Promise<RedmineIssueSummaryRaw[]> {
    const result = await transport.searchIssues({
      projectId: profile.projectId,
      customFieldFilters: { ...scopeFilters(profile, scope), [profile.customFieldIds.threadId]: scope.threadId },
      offset: 0,
      limit: pageSize,
      order: "updated_desc"
    }, options?.signal);
    return result.issues;
  }

  async function resolveIssue(
    scope: FeedbackRepositoryScope & { threadId: string },
    options?: FeedbackRepositoryOptions
  ): Promise<{ issueId: number; issue: RedmineIssueRaw }> {
    const issues = await searchByThread(scope, options);
    if (issues.length === 0) throw notFound("Redmine threadがありません");
    if (issues.length > 1) throw integrity("Redmine thread IDが一意ではありません");
    const issue = await transport.getIssue(issues[0]!.id, options?.signal);
    const mapped = await mapRedmineIssue(issue, profile, scope, codec);
    if (mapped.thread.threadId !== scope.threadId) throw integrity("Redmine custom fieldとEnvelopeのthread IDが一致しません");
    return { issueId: issue.id, issue };
  }

  async function readUniqueThread(scope: FeedbackRepositoryScope & { threadId: string }, options?: FeedbackRepositoryOptions) {
    const resolved = await resolveIssue(scope, options);
    return mapRedmineIssue(resolved.issue, profile, scope, codec);
  }

  async function messageResult(
    issue: RedmineIssueRaw,
    scope: FeedbackRepositoryScope & { threadId: string },
    intentId: string,
    messageId: string,
    disposition: "created" | "recovered" | "already_applied",
    _options?: FeedbackRepositoryOptions
  ): Promise<FeedbackMessageCommandResultV2> {
    const mapped = await mapRedmineIssue(issue, profile, scope, codec);
    const message = mapped.thread.messages.find((candidate) => candidate.messageId === messageId);
    if (!message) throw integrity("Redmine write後にmessageを再構築できません");
    return { disposition, intentId, message };
  }

  async function recoverMessageAfterUnknown(
    scope: FeedbackRepositoryScope & { threadId: string },
    operation: "feedback:reply",
    intentId: string,
    requestHash: string,
    options?: FeedbackRepositoryOptions
  ): Promise<FeedbackMessageCommandResultV2 | FeedbackIntentRecoveryResultFor<"feedback:reply">> {
    const resolved = await resolveIssue(scope, options);
    const outcome = await scanIntent(resolved.issue, scope.threadId, intentId, requestHash, operation);
    if (outcome.kind === "one") return messageResult(resolved.issue, scope, intentId, outcome.stableResultId, "recovered", options);
    if (outcome.kind === "many") return repair(intentId, operation, "同じreply intentが複数あります", "recover-only");
    return pending(intentId, operation);
  }

  async function attachmentResult(
    issue: RedmineIssueRaw,
    scope: FeedbackRepositoryScope & { threadId: string; command: FeedbackUploadAttachmentCommandV2 },
    attachmentId: string,
    disposition: "created" | "recovered" | "already_applied",
    _options?: FeedbackRepositoryOptions
  ): Promise<FeedbackAttachmentCommandResultV2> {
    const mapped = await mapRedmineIssue(issue, profile, scope, codec);
    const attachment = mapped.thread.messages.flatMap((message) => message.attachments)
      .find((candidate) => candidate.attachmentId === attachmentId);
    if (!attachment) throw integrity("Redmine write後にattachmentを再構築できません");
    return { disposition, intentId: scope.command.intentId, attachment };
  }

  async function scanIntent(
    issue: RedmineIssueRaw,
    threadId: string,
    intentId: string,
    requestHash: string,
    operation: FeedbackRecoverableOperation
  ): Promise<{ kind: "none" } | { kind: "one"; stableResultId: string } | { kind: "many" }> {
    const results: string[] = [];
    for (const raw of array(issue.journals)) {
      const journal = record(raw);
      const marked = parseRedmineMessageNote(journal.notes);
      const value = operation === "feedback:attachment:upload"
        ? marked?.metadata.feedbackV2Attachment
        : marked?.metadata.feedbackV2;
      if (!value || value.intentId !== intentId) continue;
      const verification = operation === "feedback:attachment:upload"
        ? await codec.verifyAttachmentMarker(value as FeedbackAttachmentMarkerV2, binding(profile, issue.id))
        : await codec.verifyMessageMarker(value as FeedbackMessageMarkerV2, binding(profile, issue.id));
      if (!verification.valid) throw integrity(`intent markerを検証できません: ${verification.reason}`);
      if (value.threadId !== threadId || value.requestHash !== requestHash) throw integrity("同じintent IDのbindingが異なります");
      if (operation === "feedback:reply" && "eventKind" in value && value.eventKind !== "reply" ||
        operation === "feedback:revise" && "eventKind" in value && value.eventKind !== "revision") {
        throw integrity("同じintent IDのoperationが異なります");
      }
      const stableResultId = "attachmentId" in value && typeof value.attachmentId === "string"
        ? value.attachmentId
        : "eventKind" in value && value.eventKind === "reply" && typeof value.messageId === "string"
          ? value.messageId
          : "eventId" in value && typeof value.eventId === "string" ? value.eventId : null;
      if (!stableResultId) throw integrity("intent markerにstable result IDがありません");
      results.push(stableResultId);
    }
    return results.length === 0 ? { kind: "none" } : results.length === 1 ? { kind: "one", stableResultId: results[0]! } : { kind: "many" };
  }

  return Object.freeze(repository);
}

function capabilities(profile: FeedbackRedmineProfileV2): FeedbackCapabilitiesV2 {
  return {
    ...redmineContractFixture.capabilities,
    maximumAttachmentBytes: profile.maximumAttachmentBytes,
    attachmentContentTypes: [...profile.attachmentContentTypes]
  };
}

function createIssueInput(profile: FeedbackRedmineProfileV2, command: FeedbackCreateThreadCommandV2) {
  return {
    project_id: profile.projectId,
    tracker_id: profile.trackerId,
    subject: command.title,
    description: command.body,
    is_private: profile.isPrivate,
    ...(profile.defaultPriorityId === undefined ? {} : { priority_id: profile.defaultPriorityId }),
    custom_fields: [
      { id: profile.customFieldIds.threadId, value: command.threadId },
      { id: profile.customFieldIds.intentId, value: command.intentId },
      { id: profile.customFieldIds.requestHash, value: command.requestHash.slice("sha256:".length) },
      { id: profile.customFieldIds.applicationKey, value: profile.applicationKey },
      { id: profile.customFieldIds.environmentKey, value: profile.environmentKey },
      { id: profile.customFieldIds.externalWorkspaceKey, value: profile.workspaceId },
      { id: profile.customFieldIds.hostResourceKey, value: command.resource.key }
    ]
  };
}

async function signReplyMarker(
  issueId: number,
  threadId: string,
  command: FeedbackReplyCommandV2,
  profile: FeedbackRedmineProfileV2,
  codec: FeedbackEnvelopeCodecPort,
  createdAt: string
) {
  return codec.signMessageMarker({
    schemaVersion: "2", threadId, eventId: command.messageId, eventKind: "reply", messageId: command.messageId,
    intentId: command.intentId, requestHash: command.requestHash, participantId: profile.participantId,
    bodyHash: calculateFeedbackCommandHash({ body: command.body }), providerBinding: binding(profile, issueId), createdAt
  });
}

async function signRevisionMarker(
  issueId: number,
  threadId: string,
  messageId: string,
  command: FeedbackAppendRevisionCommandV2,
  profile: FeedbackRedmineProfileV2,
  codec: FeedbackEnvelopeCodecPort,
  createdAt: string
) {
  return codec.signMessageMarker({
    schemaVersion: "2", threadId, eventId: command.revisionId, eventKind: "revision", messageId,
    expectedRevisionId: command.expectedRevisionId, intentId: command.intentId, requestHash: command.requestHash,
    participantId: profile.participantId, bodyHash: calculateFeedbackCommandHash({ body: command.body }),
    providerBinding: binding(profile, issueId), createdAt
  });
}

function binding(profile: FeedbackRedmineProfileV2, issueId: number) {
  return { profileId: profile.profileId, installationId: profile.installationId, objectId: String(issueId) };
}

function scopeFilters(profile: FeedbackRedmineProfileV2, scope: FeedbackRepositoryScope): Record<number, string> {
  return {
    ...baseFilters(profile),
    [profile.customFieldIds.externalWorkspaceKey]: scope.workspaceId,
    [profile.customFieldIds.hostResourceKey]: scope.resource.key
  };
}

function baseFilters(profile: FeedbackRedmineProfileV2): Record<number, string> {
  return {
    [profile.customFieldIds.applicationKey]: profile.applicationKey,
    [profile.customFieldIds.environmentKey]: profile.environmentKey,
    [profile.customFieldIds.externalWorkspaceKey]: profile.workspaceId
  };
}

function assertSeed(issue: RedmineIssueRaw, intentId: string, requestHash: string, profile: FeedbackRedmineProfileV2): void {
  const storedIntent = customFieldText(issue, profile.customFieldIds.intentId);
  const storedHash = customFieldText(issue, profile.customFieldIds.requestHash);
  if (storedIntent !== intentId || (storedHash !== requestHash && `sha256:${storedHash}` !== requestHash)) {
    throw integrity("Redmine first-write recovery seedがrequestと一致しません");
  }
}

function assertCreateCommand(command: FeedbackCreateThreadCommandV2, scope: FeedbackRepositoryScope): void {
  if (command.resource.kind !== scope.resource.kind || command.resource.key !== scope.resource.key) {
    throw new FeedbackConnectorProblem({ code: "feedback.conflict", status: 409, retryable: false, message: "command resourceがrequest scopeと一致しません" });
  }
}

function assertUpload(profile: FeedbackRedmineProfileV2, command: FeedbackUploadAttachmentCommandV2, sourceSize: number): void {
  if (command.sizeBytes !== sourceSize || command.sizeBytes > profile.maximumAttachmentBytes) {
    throw new FeedbackConnectorProblem({ code: "feedback.unsupported", status: 413, retryable: false, message: "attachment sizeがprofile policyに適合しません" });
  }
  if (!profile.attachmentContentTypes.includes(command.contentType)) {
    throw new FeedbackConnectorProblem({ code: "feedback.unsupported", status: 415, retryable: false, message: "attachment content typeがprofile policyに適合しません" });
  }
}

function assertProfile(profile: FeedbackRedmineProfileV2, profileId: string): void {
  if (profile.profileId !== profileId) throw notFound("Redmine profileがありません");
}

function assertWorkspace(profile: FeedbackRedmineProfileV2, workspaceId: string): void {
  if (profile.workspaceId !== workspaceId) throw notFound("Redmine workspaceがありません");
}

function assertScope(profile: FeedbackRedmineProfileV2, scope: FeedbackRepositoryScope): void {
  assertProfile(profile, scope.profileId);
  assertWorkspace(profile, scope.workspaceId);
  if (!scope.resource.kind || !scope.resource.key) throw integrity("Redmine resource scopeが不正です");
}

function projectionMatches(projection: FeedbackProjectionV2, scope: FeedbackRepositoryScope): boolean {
  return projection.profileId === scope.profileId && projection.workspaceId === scope.workspaceId &&
    projection.resource.kind === scope.resource.kind && projection.resource.key === scope.resource.key;
}

function scopeFromProjection(projection: FeedbackProjectionV2, profile: FeedbackRedmineProfileV2): FeedbackRepositoryScope {
  return { profileId: profile.profileId, installationId: profile.installationId, workspaceId: projection.workspaceId, resource: projection.resource };
}

function resourceFingerprint(profile: FeedbackRedmineProfileV2, query: string | undefined): string {
  return calculateFeedbackCommandHash({ profileId: profile.profileId, workspaceId: profile.workspaceId, query: query ?? null });
}

function threadFingerprint(scope: FeedbackRepositoryScope & { order?: string }): string {
  return calculateFeedbackCommandHash({ profileId: scope.profileId, workspaceId: scope.workspaceId, resource: scope.resource, order: scope.order ?? "updated_desc" });
}

function cursor(offset: number, fingerprint: string): string {
  return `redmine:${offset}:${fingerprint}`;
}

function parseCursor(value: string | undefined, fingerprint: string): number {
  if (!value) return 0;
  const match = /^redmine:([0-9]+):(sha256:[a-f0-9]{64})$/u.exec(value);
  if (!match || match[2] !== fingerprint || !Number.isSafeInteger(Number(match[1]))) throw invalidCursor();
  return Number(match[1]);
}

function customFieldText(issue: RedmineIssueSummaryRaw, id: number): string | null {
  for (const raw of array(issue.custom_fields)) {
    const field = record(raw);
    if (field.id === id && typeof field.value === "string" && field.value.trim()) return field.value.trim();
  }
  return null;
}

function uniqueNewAttachment(issue: RedmineIssueRaw, command: FeedbackUploadAttachmentCommandV2): string {
  const matches = array(issue.attachments).map(record).filter((attachment) =>
    attachment.filename === command.filename && attachment.filesize === command.sizeBytes &&
    (attachment.content_type === command.contentType || !attachment.content_type));
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0]!.id)) throw integrity("upload済みattachmentを一意に解決できません");
  return String(matches[0]!.id);
}

function providerAttachmentBinding(issue: RedmineIssueRaw, threadId: string, attachmentId: string): {
  providerId: string;
  marker: FeedbackAttachmentMarkerV2 | null;
} | null {
  for (const raw of array(issue.journals)) {
    const marker = parseRedmineMessageNote(record(raw).notes)?.metadata.feedbackV2Attachment;
    if (marker?.threadId === threadId && marker.attachmentId === attachmentId) {
      return { providerId: marker.providerAttachmentId, marker };
    }
  }
  for (const raw of array(issue.attachments)) {
    const attachment = record(raw);
    if (deriveLegacyAttachmentId(issue.id, attachment.id) === attachmentId) {
      return { providerId: String(attachment.id), marker: null };
    }
  }
  return null;
}

async function collectDownload(body: AsyncIterable<Uint8Array>, maximumBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    if (!(chunk instanceof Uint8Array)) throw integrity("Redmine attachment streamがUint8Arrayではありません");
    size += chunk.byteLength;
    if (size > maximumBytes) throw integrity("Redmine attachment streamがprofile上限を超えました");
    chunks.push(Uint8Array.from(chunk));
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function deriveLegacyAttachmentId(issueId: number, providerId: unknown): string {
  // mapperと同じdomainを共有し、legacy attachmentをprocess再起動後も再構築する。
  return deriveRedmineStableId("attachment", issueId, String(providerId));
}

function pending<TOperation extends FeedbackRecoverableOperation>(
  intentId: string,
  operation: TOperation
): FeedbackIntentRecoveryResultFor<TOperation> {
  return { intentId, state: "pending", operation, retryAfterSeconds: 2, automaticWriteAllowed: false };
}

function repair<TOperation extends FeedbackRecoverableOperation>(
  intentId: string,
  operation: TOperation,
  detail: string,
  retryDirective: "recover-only" | "manual-confirmation" | "do-not-write"
): FeedbackIntentRecoveryResultFor<TOperation> {
  return { intentId, state: "repair_required", operation, detail, automaticWriteAllowed: false, retryDirective };
}

function couldBeUnknownProviderResult(error: unknown): boolean {
  return !(error instanceof FeedbackConnectorProblem) || error.retryable ||
    error.code === "feedback.provider_timeout" || error.code === "feedback.provider_unavailable";
}

function normalizeProviderError(error: unknown): FeedbackConnectorProblem {
  if (error instanceof FeedbackConnectorProblem) return error;
  return new FeedbackConnectorProblem({
    code: "feedback.provider_unavailable",
    status: 502,
    retryable: true,
    message: error instanceof Error ? error.message : "Redmine provider error"
  });
}

function invalidCursor(): FeedbackConnectorProblem {
  return new FeedbackConnectorProblem({ code: "feedback.conflict", status: 400, retryable: false, message: "Redmine cursorがqueryと一致しません" });
}

function notFound(message: string): FeedbackConnectorProblem {
  return new FeedbackConnectorProblem({ code: "feedback.not_found", status: 404, retryable: false, message });
}

function integrity(message: string): FeedbackConnectorProblem {
  return new FeedbackConnectorProblem({ code: "feedback.integrity_error", status: 502, retryable: false, message });
}

function array(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : (() => { throw integrity("Redmine provider arrayが不正です"); })();
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw integrity("Redmine provider objectが不正です");
  return value as Record<string, unknown>;
}
