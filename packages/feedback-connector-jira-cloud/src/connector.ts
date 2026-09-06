import { createHash } from "node:crypto";
import type {
  FeedbackIntentRecoveryResultFor,
  FeedbackProjectionCandidate,
  FeedbackRecoverableOperation,
  FeedbackRepositoryOptions,
  FeedbackRepositoryPort,
  FeedbackRepositoryScope
} from "@geibee/feedback-connector-sdk";
import {
  calculateFeedbackCommandHash,
  type FeedbackEnvelopeCodecPort
} from "@geibee/feedback-envelope";
import {
  JiraCloudRestV3Client,
  type JiraCloudAttachment,
  type JiraCloudComment,
  type JiraCloudIssue
} from "./rest-v3-client.js";
import {
  JiraCloudConnectorProblem,
  jiraCloudAttachmentPropertyPrefix,
  jiraCloudMessagePropertyKey,
  jiraCloudRecoveryPropertyKey,
  type JiraCloudBoundRecoveryProperty,
  type JiraCloudConnectorConfiguration,
  type JiraCloudRawCandidateMetadata,
  type JiraCloudRecoverySeed,
  type JiraCloudTransport
} from "./types.js";

type FeedbackCapabilities = Awaited<ReturnType<FeedbackRepositoryPort["getCapabilities"]>>;
type FeedbackThread = Awaited<ReturnType<FeedbackRepositoryPort["readCandidate"]>>["thread"];
type FeedbackMessage = FeedbackThread["messages"][number];
type FeedbackAttachment = FeedbackMessage["attachments"][number];
type FeedbackIntentRecoveryResult = Awaited<ReturnType<FeedbackRepositoryPort["recoverIntent"]>>;
type FeedbackThreadCommandResult = Extract<Awaited<ReturnType<FeedbackRepositoryPort["createThread"]>>, { disposition: string }>;
type FeedbackMessageCommandResult = Extract<Awaited<ReturnType<FeedbackRepositoryPort["reply"]>>, { disposition: string }>;
type FeedbackAttachmentCommandResult = Extract<Awaited<ReturnType<FeedbackRepositoryPort["uploadAttachment"]>>, { disposition: string }>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const hash = /^sha256:[a-f0-9]{64}$/u;
const projectKey = /^[A-Z][A-Z0-9_]{1,127}$/u;

export type JiraCloudConnectorOptions = {
  configuration: JiraCloudConnectorConfiguration;
  transport: JiraCloudTransport;
  envelopeCodec: FeedbackEnvelopeCodecPort;
  now?: () => Date;
};

/** request participantごとに生成し、共有credentialはtransport内へ閉じ込める。 */
export function createFeedbackJiraCloudConnector(options: JiraCloudConnectorOptions): FeedbackRepositoryPort {
  return new FeedbackJiraCloudConnector(options);
}

class FeedbackJiraCloudConnector implements FeedbackRepositoryPort {
  readonly config: Readonly<JiraCloudConnectorConfiguration>;
  readonly client: JiraCloudRestV3Client;
  readonly codec: FeedbackEnvelopeCodecPort;
  readonly now: () => Date;
  readonly pageSize: number;

  constructor(options: JiraCloudConnectorOptions) {
    validateConfiguration(options.configuration);
    this.config = Object.freeze({ ...options.configuration, attachmentContentTypes: [...options.configuration.attachmentContentTypes] });
    this.client = new JiraCloudRestV3Client(options.transport);
    this.codec = options.envelopeCodec;
    this.now = options.now ?? (() => new Date());
    this.pageSize = options.configuration.pageSize ?? 50;
  }

  async getCapabilities(): Promise<FeedbackCapabilities> {
    return {
      backendOperations: [
        "feedback:read", "feedback:create", "feedback:reply", "feedback:revise",
        "feedback:attachment:read", "feedback:attachment:upload"
      ],
      discovery: { workspaces: "supported", resources: "supported" },
      operationGuarantees: {
        create: "recoverable",
        reply: "recoverable",
        revision: "best-effort",
        attachmentUpload: "best-effort"
      },
      creationFields: [],
      maximumAttachmentBytes: this.config.maximumAttachmentBytes,
      attachmentContentTypes: [...this.config.attachmentContentTypes]
    };
  }

  async listWorkspaces(profileId: string, cursor?: string, options?: FeedbackRepositoryOptions) {
    this.assertProfile(profileId);
    const fingerprint = calculateFeedbackCommandHash({ operation: "list-workspaces", profileId });
    const startAt = readOffsetCursor(cursor, fingerprint);
    const page = await this.client.listProjects({ startAt, maxResults: this.pageSize, signal: options?.signal });
    const next = startAt + page.values.length;
    return {
      items: page.values.map((project) => ({ workspaceId: project.key, displayName: project.name })),
      nextCursor: next < page.total ? offsetCursor(fingerprint, next) : null
    };
  }

  async listResources(query: { profileId: string; workspaceId: string; query?: string; cursor?: string }, options?: FeedbackRepositoryOptions) {
    this.assertProfile(query.profileId);
    assertProjectKey(query.workspaceId);
    const fingerprint = calculateFeedbackCommandHash({
      operation: "list-resources",
      profileId: query.profileId,
      workspaceId: query.workspaceId,
      query: query.query ?? null
    });
    const startAt = readOffsetCursor(query.cursor, fingerprint);
    const page = await this.client.listComponents({ projectKey: query.workspaceId, startAt, maxResults: this.pageSize, signal: options?.signal });
    const needle = query.query?.trim().toLocaleLowerCase();
    const values = needle ? page.values.filter((component) => component.name.toLocaleLowerCase().includes(needle)) : page.values;
    const next = startAt + page.values.length;
    return {
      items: values.map((component) => ({ resource: { kind: "record", key: component.id }, displayName: component.name })),
      nextCursor: next < page.total ? offsetCursor(fingerprint, next) : null
    };
  }

  async findThreadCandidates(
    query: FeedbackRepositoryScope & { cursor?: string; order?: "updated_desc" | "updated_asc" },
    options?: FeedbackRepositoryOptions
  ) {
    this.assertScope(query);
    const order = query.order ?? "updated_desc";
    const fingerprint = calculateFeedbackCommandHash({
      operation: "find-threads",
      profileId: query.profileId,
      installationId: query.installationId,
      workspaceId: query.workspaceId,
      resource: query.resource,
      order
    });
    const nextPageToken = readTokenCursor(query.cursor, fingerprint);
    const direction = order === "updated_desc" ? "DESC" : "ASC";
    const page = await this.client.searchIssues({
      jql: `project = ${query.workspaceId} AND issue.property['${jiraCloudRecoveryPropertyKey}'].threadId IS NOT EMPTY ORDER BY updated ${direction}, id ${direction}`,
      maxResults: this.pageSize,
      ...(nextPageToken ? { nextPageToken } : {}),
      fields: ["summary", "status", "created", "updated"],
      properties: [jiraCloudRecoveryPropertyKey],
      signal: options?.signal
    });
    const candidates = page.issues.map((issue) => {
      const property = issue.properties?.[jiraCloudRecoveryPropertyKey];
      const projection = projectionFromProperty(property, this.config);
      return { providerRef: providerRef(issue), projection };
    });
    return {
      candidates,
      nextCursor: page.nextPageToken ? tokenCursor(fingerprint, page.nextPageToken) : null
    };
  }

  async findThreadCandidatesById(query: FeedbackRepositoryScope & { threadId: string }, options?: FeedbackRepositoryOptions): Promise<FeedbackProjectionCandidate[]> {
    this.assertScope(query);
    assertUuid(query.threadId, "threadId");
    const issues = await this.searchAll({
      jql: `project = ${query.workspaceId} AND issue.property['${jiraCloudRecoveryPropertyKey}'].threadId = "${query.threadId}"`,
      signal: options?.signal
    });
    return issues.map((issue) => {
      const property = issue.properties?.[jiraCloudRecoveryPropertyKey];
      const projection = projectionFromProperty(property, this.config);
      return { providerRef: providerRef(issue), projection };
    });
  }

  async readCandidate(candidate: FeedbackProjectionCandidate, options?: FeedbackRepositoryOptions) {
    this.assertProviderRef(candidate);
    const issueId = candidate.providerRef.objectId;
    const [issue, recoveryProperty, comments, attachmentMarkers] = await Promise.all([
      this.client.getIssue(issueId, options?.signal),
      this.client.getIssueProperty(issueId, jiraCloudRecoveryPropertyKey, options?.signal),
      this.readCommentsWithMarkers(issueId, options?.signal),
      this.readAttachmentMarkers(issueId, options?.signal)
    ]);
    const envelope = envelopeFromRecovery(recoveryProperty);
    const metadata: JiraCloudRawCandidateMetadata = {
      provider: "jira-cloud",
      recoveryProperty,
      commentMarkers: comments.flatMap((item) => item.marker === null ? [] : [{ providerCommentId: item.comment.id, marker: item.marker }]),
      attachmentMarkers
    };
    const thread = await this.mapThread(issue, envelope, comments, attachmentMarkers);
    return {
      providerRef: providerRef(issue),
      envelope,
      legacyMetadata: metadata,
      thread
    };
  }

  async createThread(
    query: FeedbackRepositoryScope & { command: Parameters<FeedbackRepositoryPort["createThread"]>[0]["command"] },
    options?: FeedbackRepositoryOptions
  ): Promise<FeedbackThreadCommandResult | FeedbackIntentRecoveryResultFor<"feedback:create">> {
    this.assertScope(query);
    assertUuid(query.command.threadId, "threadId");
    assertUuid(query.command.intentId, "intentId");
    assertHash(query.command.requestHash);
    if (query.command.resource.kind !== query.resource.kind || query.command.resource.key !== query.resource.key) {
      throw invalid("create command resourceがrequest scopeと一致しません");
    }
    const seed = recoverySeed(query);
    let created: { id: string; key: string };
    try {
      created = await this.client.createIssue({
        fields: {
          project: { key: query.workspaceId },
          issuetype: { id: this.config.issueTypeId },
          summary: query.command.title,
          description: textToAdf(query.command.body)
        },
        properties: [{ key: jiraCloudRecoveryPropertyKey, value: seed }],
        signal: options?.signal
      });
    } catch (error) {
      if (!unknownWriteResult(error)) throw error;
      return this.recoverCreate(recoveryQuery(query, "feedback:create"), options);
    }

    const envelope = await this.codec.signEnvelope({
      schemaVersion: "2",
      threadId: query.command.threadId,
      intentId: query.command.intentId,
      requestHash: query.command.requestHash,
      initialBodyHash: calculateFeedbackCommandHash({ body: query.command.body }),
      providerBinding: { profileId: query.profileId, installationId: query.installationId, objectId: created.id },
      scope: {
        workspace: query.workspaceId,
        resource: query.resource,
        application: this.config.application,
        environment: this.config.environment
      },
      createdBy: { participantId: this.config.participantId },
      createdAt: this.now().toISOString()
    });
    const bound: JiraCloudBoundRecoveryProperty = { ...seed, state: "bound", envelope };
    try {
      await this.client.setIssueProperty(created.id, jiraCloudRecoveryPropertyKey, bound, options?.signal);
      const reread = await this.client.getIssueProperty(created.id, jiraCloudRecoveryPropertyKey, options?.signal);
      await this.assertBoundProperty(reread, query, created.id);
      const record = await this.readCandidate({ providerRef: { providerKey: "jira-cloud", objectId: created.id }, projection: projectionFromProperty(reread, this.config) }, options);
      return { disposition: "created", intentId: query.command.intentId, thread: record.thread } satisfies FeedbackThreadCommandResult;
    } catch (error) {
      if (!recoverableMetadataFailure(error)) throw error;
      return this.recoverCreate(recoveryQuery(query, "feedback:create"), options);
    }
  }

  async reply(
    query: FeedbackRepositoryScope & { threadId: string; command: Parameters<FeedbackRepositoryPort["reply"]>[0]["command"] },
    options?: FeedbackRepositoryOptions
  ): Promise<FeedbackMessageCommandResult | FeedbackIntentRecoveryResultFor<"feedback:reply">> {
    this.assertScope(query);
    const resolved = await this.resolveThread(query, "feedback:reply", query.command.intentId, options);
    if (!("issue" in resolved)) return resolved;
    const marker = await this.codec.signMessageMarker({
      schemaVersion: "2",
      threadId: query.threadId,
      eventId: query.command.messageId,
      eventKind: "reply",
      messageId: query.command.messageId,
      intentId: query.command.intentId,
      requestHash: query.command.requestHash,
      participantId: this.config.participantId,
      bodyHash: calculateFeedbackCommandHash({ body: query.command.body }),
      providerBinding: { profileId: query.profileId, installationId: query.installationId, objectId: resolved.issue.id },
      createdAt: this.now().toISOString()
    });
    try {
      const comment = await this.client.createComment({
        issueId: resolved.issue.id,
        body: textToAdf(query.command.body),
        property: { key: jiraCloudMessagePropertyKey, value: marker },
        signal: options?.signal
      });
      const reread = await this.client.getCommentProperty(resolved.issue.id, comment.id, jiraCloudMessagePropertyKey, options?.signal);
      await this.assertMessageMarker(reread, query, resolved.issue.id);
      assertCommentBodyHash(comment, reread);
      return {
        disposition: "created",
        intentId: query.command.intentId,
        message: messageFromComment(comment, marker, this.config.participantId)
      } satisfies FeedbackMessageCommandResult;
    } catch (error) {
      if (!unknownWriteResult(error)) throw error;
      const recovery = await this.recoverIntent(recoveryQuery(query, "feedback:reply"), options) as FeedbackIntentRecoveryResultFor<"feedback:reply">;
      return recovery.state === "not_found" ? pending(query.command.intentId, "feedback:reply", this.retryAfter) : recovery;
    }
  }

  async appendRevision(
    query: FeedbackRepositoryScope & { threadId: string; messageId: string; command: Parameters<FeedbackRepositoryPort["appendRevision"]>[0]["command"] },
    options?: FeedbackRepositoryOptions
  ): Promise<FeedbackMessageCommandResult | FeedbackIntentRecoveryResultFor<"feedback:revise">> {
    this.assertScope(query);
    const resolved = await this.resolveThread(query, "feedback:revise", query.command.intentId, options);
    if (!("issue" in resolved)) return resolved;
    const comments = await this.readCommentsWithMarkers(resolved.issue.id, options?.signal);
    const latest = await this.latestRevisionId(query.messageId, query, resolved.issue.id, comments);
    if (latest !== query.command.expectedRevisionId) {
      throw new JiraCloudConnectorProblem({
        message: `revision競合です: expected=${query.command.expectedRevisionId}, actual=${latest}`,
        status: 409,
        code: "feedback.conflict",
        retryable: false
      });
    }
    const marker = await this.codec.signMessageMarker({
      schemaVersion: "2",
      threadId: query.threadId,
      eventId: query.command.revisionId,
      eventKind: "revision",
      messageId: query.messageId,
      expectedRevisionId: query.command.expectedRevisionId,
      intentId: query.command.intentId,
      requestHash: query.command.requestHash,
      participantId: this.config.participantId,
      bodyHash: calculateFeedbackCommandHash({ body: query.command.body }),
      providerBinding: { profileId: query.profileId, installationId: query.installationId, objectId: resolved.issue.id },
      createdAt: this.now().toISOString()
    });
    try {
      const comment = await this.client.createComment({
        issueId: resolved.issue.id,
        body: textToAdf(query.command.body),
        property: { key: jiraCloudMessagePropertyKey, value: marker },
        signal: options?.signal
      });
      const reread = await this.client.getCommentProperty(resolved.issue.id, comment.id, jiraCloudMessagePropertyKey, options?.signal);
      await this.assertMessageMarker(reread, query, resolved.issue.id);
      assertCommentBodyHash(comment, reread);
      return {
        disposition: "created",
        intentId: query.command.intentId,
        message: messageFromRevision(comment, marker, this.config.participantId)
      } satisfies FeedbackMessageCommandResult;
    } catch (error) {
      if (!unknownWriteResult(error)) throw error;
      const recovery = await this.recoverIntent(recoveryQuery(query, "feedback:revise"), options) as FeedbackIntentRecoveryResultFor<"feedback:revise">;
      return recovery.state === "completed" ? recovery : repair(query.command.intentId, "feedback:revise", "revision結果を一意に確認できません", "do-not-write");
    }
  }

  async recoverIntent(query: Parameters<FeedbackRepositoryPort["recoverIntent"]>[0], options?: FeedbackRepositoryOptions): Promise<FeedbackIntentRecoveryResult> {
    this.assertScope(query);
    assertUuid(query.threadId, "threadId");
    assertUuid(query.intentId, "intentId");
    assertHash(query.requestHash);
    if (query.operation === "feedback:create") {
      return this.recoverCreate({ ...query, operation: "feedback:create" }, options);
    }

    const resolved = await this.resolveThread(query, query.operation, query.intentId, options);
    if (!("issue" in resolved)) return resolved;
    if (query.operation === "feedback:attachment:upload") {
      const markers = await this.readAttachmentMarkers(resolved.issue.id, options?.signal);
      const matches = markers.filter((item) => markerMatches(item.marker, query.intentId, query.requestHash));
      if (matches.length === 1) {
        const verification = await this.codec.verifyAttachmentMarker(matches[0]!.marker, bindingContext(query, resolved.issue.id));
        if (!verification.valid) throw integrity(`attachment marker検証失敗: ${verification.reason}`);
        return completed(query.intentId, query.operation, verification.value.attachmentId);
      }
      return repair(query.intentId, query.operation,
        matches.length > 1 ? "attachment mappingが複数あります" : "attachment upload結果を確認できません",
        "manual-confirmation");
    }

    const expectedKind = query.operation === "feedback:reply" ? "reply" : "revision";
    const comments = await this.readCommentsWithMarkers(resolved.issue.id, options?.signal);
    const matches = comments.filter((item) => markerMatches(item.marker, query.intentId, query.requestHash) && markerKind(item.marker) === expectedKind);
    if (matches.length === 0) return { intentId: query.intentId, state: "not_found", operation: query.operation };
    if (matches.length > 1) return repair(query.intentId, query.operation, "同じintentのcommentが複数あります", "do-not-write");
    const verification = await this.codec.verifyMessageMarker(matches[0]!.marker, bindingContext(query, resolved.issue.id));
    if (!verification.valid) throw integrity(`message marker検証失敗: ${verification.reason}`);
    assertCommentBodyHash(matches[0]!.comment, verification.value);
    return completed(query.intentId, query.operation, verification.value.eventId);
  }

  async uploadAttachment(
    query: Parameters<FeedbackRepositoryPort["uploadAttachment"]>[0],
    options?: FeedbackRepositoryOptions
  ): Promise<FeedbackAttachmentCommandResult | FeedbackIntentRecoveryResultFor<"feedback:attachment:upload">> {
    this.assertScope(query);
    if (query.command.sizeBytes !== query.source.sizeBytes) throw invalid("attachment source sizeがcommandと一致しません");
    if (query.command.sizeBytes > this.config.maximumAttachmentBytes) {
      throw new JiraCloudConnectorProblem({ message: "attachment上限を超えました", status: 413, code: "feedback.payload_too_large", retryable: false });
    }
    if (!this.config.attachmentContentTypes.includes(query.command.contentType)) {
      throw new JiraCloudConnectorProblem({ message: "attachment media typeは未対応です", status: 415, code: "feedback.unsupported_media_type", retryable: false });
    }
    const resolved = await this.resolveThread(query, "feedback:attachment:upload", query.command.intentId, options);
    if (!("issue" in resolved)) return resolved;
    const targetMessageId = query.command.messageId ?? query.threadId;
    assertUuid(targetMessageId, "attachment messageId");
    const verifiedThread = await this.readVerifiedThread(resolved.issue, resolved.property, options?.signal);
    if (!verifiedThread.messages.some((message) => message.messageId === targetMessageId)) {
      throw new JiraCloudConnectorProblem({
        message: "attachment対象messageが現在threadにありません",
        status: 404,
        code: "feedback.not_found",
        retryable: false
      });
    }

    let providerAttachment: JiraCloudAttachment;
    try {
      providerAttachment = await this.client.uploadAttachment({
        issueId: resolved.issue.id,
        filename: query.command.filename,
        contentType: query.command.contentType,
        sizeBytes: query.command.sizeBytes,
        source: query.source,
        signal: options?.signal
      });
    } catch (error) {
      if (!unknownWriteResult(error)) throw error;
      return repair(query.command.intentId, "feedback:attachment:upload", "binary upload結果が不明です", "manual-confirmation");
    }

    let marker: Awaited<ReturnType<FeedbackEnvelopeCodecPort["signAttachmentMarker"]>>;
    try {
      marker = await this.codec.signAttachmentMarker({
        schemaVersion: "2",
        threadId: query.threadId,
        messageId: targetMessageId,
        attachmentId: query.command.attachmentId,
        intentId: query.command.intentId,
        requestHash: query.command.requestHash,
        providerBinding: { profileId: query.profileId, installationId: query.installationId, objectId: resolved.issue.id },
        providerAttachmentId: providerAttachment.id,
        filename: query.command.filename,
        contentType: query.command.contentType,
        sizeBytes: query.command.sizeBytes,
        contentHash: query.command.contentHash,
        createdAt: providerAttachment.created
      });
      const propertyKey = attachmentPropertyKey(query.command.attachmentId);
      await this.client.setIssueProperty(resolved.issue.id, propertyKey, marker, options?.signal);
      const reread = await this.client.getIssueProperty(resolved.issue.id, propertyKey, options?.signal);
      const verification = await this.codec.verifyAttachmentMarker(reread, bindingContext(query, resolved.issue.id));
      if (!verification.valid) throw integrity(`attachment mapping検証失敗: ${verification.reason}`);
    } catch {
      return repair(query.command.intentId, "feedback:attachment:upload", "upload成功後の署名mappingを確認できません", "manual-confirmation");
    }
    return {
      disposition: "created",
      intentId: query.command.intentId,
      attachment: attachmentFromMarker(marker)
    } satisfies FeedbackAttachmentCommandResult;
  }

  async getAttachment(query: Parameters<FeedbackRepositoryPort["getAttachment"]>[0], options?: FeedbackRepositoryOptions) {
    this.assertScope(query);
    const resolved = await this.resolveThread(query, "feedback:attachment:upload", query.attachmentId, options);
    if (!("issue" in resolved)) throw integrity("attachmentの親threadを一意に解決できません");
    const value = await this.client.getIssueProperty(resolved.issue.id, attachmentPropertyKey(query.attachmentId), options?.signal);
    const verification = await this.codec.verifyAttachmentMarker(value, bindingContext(query, resolved.issue.id));
    if (!verification.valid || verification.value.threadId !== query.threadId || verification.value.attachmentId !== query.attachmentId) {
      throw integrity("attachment mappingがscopeと一致しません");
    }
    const metadata = await this.client.getAttachmentMetadata(verification.value.providerAttachmentId, options?.signal);
    if (metadata.filename !== verification.value.filename || metadata.mimeType !== verification.value.contentType ||
      metadata.size !== verification.value.sizeBytes) {
      throw integrity("Jira attachment metadataが署名mappingと一致しません");
    }
    const download = await this.client.downloadAttachment(metadata.id, options?.signal);
    return {
      filename: verification.value.filename,
      contentType: verification.value.contentType,
      sizeBytes: verification.value.sizeBytes,
      body: verifiedContentStream(download.body, verification.value.sizeBytes, verification.value.contentHash)
    };
  }

  private get retryAfter(): number {
    return this.config.recoveryRetryAfterSeconds ?? 2;
  }

  private async recoverCreate(
    query: RecoveryQuery<"feedback:create">,
    options?: FeedbackRepositoryOptions
  ): Promise<FeedbackIntentRecoveryResultFor<"feedback:create">> {
    const candidates = await this.findThreadCandidatesById(query, options);
    if (candidates.length === 0) return pending(query.intentId, query.operation, this.retryAfter);
    if (candidates.length > 1) return repair(query.intentId, query.operation, "同じthreadIdのissueが複数あります", "do-not-write");
    const issueId = candidates[0]!.providerRef.objectId;
    const property = await this.client.getIssueProperty(issueId, jiraCloudRecoveryPropertyKey, options?.signal);
    if (!recoveryMatches(property, query)) return repair(query.intentId, query.operation, "recovery tripletまたはscopeが一致しません", "do-not-write");
    const existingEnvelope = envelopeFromRecovery(property);
    if (existingEnvelope !== null) {
      await this.assertBoundProperty(property, query, issueId);
      return completed(query.intentId, query.operation, query.threadId);
    }
    const envelope = await this.codec.signEnvelope({
      schemaVersion: "2",
      threadId: query.threadId,
      intentId: query.intentId,
      requestHash: query.requestHash,
      providerBinding: { profileId: query.profileId, installationId: query.installationId, objectId: issueId },
      scope: { workspace: query.workspaceId, resource: query.resource, application: this.config.application, environment: this.config.environment },
      createdBy: { participantId: this.config.participantId },
      createdAt: this.now().toISOString()
    });
    const seed = property as JiraCloudRecoverySeed;
    await this.client.setIssueProperty(issueId, jiraCloudRecoveryPropertyKey, { ...seed, state: "bound", envelope }, options?.signal);
    const reread = await this.client.getIssueProperty(issueId, jiraCloudRecoveryPropertyKey, options?.signal);
    await this.assertBoundProperty(reread, query, issueId);
    return completed(query.intentId, query.operation, query.threadId);
  }

  private async resolveThread<TOperation extends "feedback:reply" | "feedback:revise" | "feedback:attachment:upload">(
    query: FeedbackRepositoryScope & { threadId: string },
    operation: TOperation,
    intentId: string,
    options?: FeedbackRepositoryOptions
  ): Promise<{ issue: JiraCloudIssue; property: unknown } | FeedbackIntentRecoveryResultFor<TOperation>> {
    const candidates = await this.findThreadCandidatesById(query, options);
    if (candidates.length === 0) return pending(intentId, operation, this.retryAfter);
    if (candidates.length > 1) return repair(intentId, operation, "同じthreadIdのissueが複数あります", "do-not-write");
    const issueId = candidates[0]!.providerRef.objectId;
    const property = await this.client.getIssueProperty(issueId, jiraCloudRecoveryPropertyKey, options?.signal);
    await this.assertBoundProperty(property, query, issueId);
    return { issue: await this.client.getIssue(issueId, options?.signal), property };
  }

  private async assertBoundProperty(property: unknown, scope: FeedbackRepositoryScope & { threadId?: string }, issueId: string): Promise<void> {
    const envelope = envelopeFromRecovery(property);
    const verification = await this.codec.verifyEnvelope(envelope, bindingContext(scope, issueId));
    if (!verification.valid) throw integrity(`Envelope検証失敗: ${verification.reason}`);
    if ((scope.threadId && verification.value.threadId !== scope.threadId) ||
      verification.value.scope.workspace !== scope.workspaceId ||
      verification.value.scope.resource.kind !== scope.resource.kind ||
      verification.value.scope.resource.key !== scope.resource.key ||
      verification.value.scope.application !== this.config.application ||
      verification.value.scope.environment !== this.config.environment) {
      throw integrity("Envelope scopeがrequest scopeと一致しません");
    }
  }

  private async assertMessageMarker(marker: unknown, scope: FeedbackRepositoryScope & { threadId: string }, issueId: string): Promise<void> {
    const verification = await this.codec.verifyMessageMarker(marker, bindingContext(scope, issueId));
    if (!verification.valid || verification.value.threadId !== scope.threadId) throw integrity("message markerがthread scopeと一致しません");
  }

  private async readCommentsWithMarkers(issueId: string, signal?: FeedbackRepositoryOptions["signal"]): Promise<readonly { comment: JiraCloudComment; marker: unknown | null }[]> {
    const comments = await this.client.getAllComments(issueId, this.pageSize, signal);
    return Promise.all(comments.map(async (comment) => {
      const inline = inlineProperty(comment.properties, jiraCloudMessagePropertyKey);
      if (inline !== undefined) return { comment, marker: inline };
      try {
        return { comment, marker: await this.client.getCommentProperty(issueId, comment.id, jiraCloudMessagePropertyKey, signal) };
      } catch (error) {
        if (error instanceof JiraCloudConnectorProblem && error.status === 404) return { comment, marker: null };
        throw error;
      }
    }));
  }

  private async readVerifiedThread(
    issue: JiraCloudIssue,
    recoveryProperty: unknown,
    signal?: FeedbackRepositoryOptions["signal"]
  ): Promise<FeedbackThread> {
    const [comments, attachmentMarkers] = await Promise.all([
      this.readCommentsWithMarkers(issue.id, signal),
      this.readAttachmentMarkers(issue.id, signal)
    ]);
    return this.mapThread(issue, envelopeFromRecovery(recoveryProperty), comments, attachmentMarkers);
  }

  private async readAttachmentMarkers(issueId: string, signal?: FeedbackRepositoryOptions["signal"]): Promise<readonly { propertyKey: string; marker: unknown }[]> {
    const keys = await this.client.listIssueProperties(issueId, signal);
    const markerKeys = keys.filter((key) => key.startsWith(jiraCloudAttachmentPropertyPrefix));
    return Promise.all(markerKeys.map(async (propertyKey) => ({
      propertyKey,
      marker: await this.client.getIssueProperty(issueId, propertyKey, signal)
    })));
  }

  private async mapThread(
    issue: JiraCloudIssue,
    envelope: unknown,
    comments: readonly { comment: JiraCloudComment; marker: unknown | null }[],
    attachmentMarkers: readonly { propertyKey: string; marker: unknown }[]
  ): Promise<FeedbackThread> {
    const rawEnvelope = isRecord(envelope) ? envelope : {};
    const threadId = typeof rawEnvelope.threadId === "string" && uuid.test(rawEnvelope.threadId) ? rawEnvelope.threadId : stableId("issue", issue.id);
    const createdAt = dateString(issue.fields.created);
    const initialBody = adfToText(issue.fields.description);
    if (rawEnvelope.initialBodyHash !== undefined && rawEnvelope.initialBodyHash !== calculateFeedbackCommandHash({ body: initialBody })) {
      throw integrity("Jira initial本文が署名済みhashと一致しません");
    }
    const initial: FeedbackMessage = {
      messageId: threadId,
      body: adfToText(issue.fields.description),
      author: rawEnvelope.initialBodyHash ? envelopeParticipant(rawEnvelope, this.config.participantId)
        : { kind: "provider-user", displayName: "Jira user" },
      createdAt,
      orderingKey: { occurredAt: createdAt, eventId: threadId },
      revisions: [],
      attachments: []
    };
    const messages = new Map<string, FeedbackMessage>([[threadId, initial]]);
    const revisionsByMessage = new Map<string, RevisionEvent[]>();
    for (const item of comments) {
      if (item.marker === null) {
        const messageId = stableId("comment", item.comment.id);
        messages.set(messageId, providerMessage(item.comment, messageId));
        continue;
      }
      const verification = await this.codec.verifyMessageMarker(item.marker, {
        profileId: this.config.profileId,
        installationId: this.config.installationId,
        objectId: issue.id
      });
      if (!verification.valid || verification.value.threadId !== threadId) throw integrity("Jira comment markerが不正です");
      assertCommentBodyHash(item.comment, verification.value);
      if (verification.value.eventKind === "reply") {
        if (messages.has(verification.value.messageId)) throw integrity("同じmessageIdのreplyが複数あります");
        messages.set(verification.value.messageId, messageFromComment(item.comment, verification.value, this.config.participantId));
      } else {
        const events = revisionsByMessage.get(verification.value.messageId) ?? [];
        events.push({ comment: item.comment, marker: verification.value });
        revisionsByMessage.set(verification.value.messageId, events);
      }
    }
    for (const [messageId, events] of revisionsByMessage) {
      const target = messages.get(messageId);
      if (!target) throw integrity("revision対象messageがありません");
      const chain = orderRevisionChain(messageId, events);
      const owner = messageId === threadId ? envelopeParticipant(rawEnvelope, this.config.participantId) : target.author;
      if (owner.kind !== "participant") {
        throw integrity("revision participantが元message authorと一致しません");
      }
      const originalParticipantId = owner.participantId;
      if (chain.some((event) => event.marker.participantId !== originalParticipantId)) {
        throw integrity("revision participantが元message authorと一致しません");
      }
      target.revisions = chain.map((event) => ({
        revisionId: event.marker.eventId,
        body: adfToText(event.comment.body),
        revisedAt: event.comment.created,
        orderingKey: { occurredAt: event.comment.created, eventId: event.marker.eventId }
      }));
      if (target.revisions.length > 0) {
        target.body = target.revisions[target.revisions.length - 1]!.body;
        target.author = owner;
      }
    }
    for (const item of attachmentMarkers) {
      const verification = await this.codec.verifyAttachmentMarker(item.marker, {
        profileId: this.config.profileId,
        installationId: this.config.installationId,
        objectId: issue.id
      });
      if (!verification.valid || verification.value.threadId !== threadId) throw integrity("Jira attachment markerが不正です");
      const target = messages.get(attachmentMessageId(verification.value));
      if (!target) throw integrity("attachment対象messageがありません");
      target.attachments.push(attachmentFromMarker(verification.value));
    }
    const ordered = [...messages.values()].sort((left, right) => compareOrdering(left.orderingKey, right.orderingKey));
    const updatedAt = dateString(issue.fields.updated ?? issue.fields.created);
    return {
      threadId,
      resource: storedResource(rawEnvelope),
      title: typeof issue.fields.summary === "string" ? issue.fields.summary : issue.key,
      status: issueClosed(issue.fields.status) ? "closed" : "open",
      createdAt,
      updatedAt,
      messageCount: ordered.length,
      messages: ordered
    };
  }

  private async latestRevisionId(
    messageId: string,
    scope: FeedbackRepositoryScope & { threadId: string },
    issueId: string,
    comments: readonly { comment: JiraCloudComment; marker: unknown | null }[]
  ): Promise<string> {
    let latest: { id: string; created: string } | undefined;
    let messageExists = messageId === scope.threadId;
    const revisions: RevisionEvent[] = [];
    for (const item of comments) {
      if (item.marker === null) continue;
      const verification = await this.codec.verifyMessageMarker(item.marker, bindingContext(scope, issueId));
      if (!verification.valid || verification.value.threadId !== scope.threadId) throw integrity("revision確認中のmarkerが不正です");
      assertCommentBodyHash(item.comment, verification.value);
      if (verification.value.eventKind === "reply" && verification.value.messageId === messageId) messageExists = true;
      if (verification.value.eventKind === "revision" && verification.value.messageId === messageId) {
        revisions.push({ comment: item.comment, marker: verification.value });
      }
    }
    if (!messageExists) throw new JiraCloudConnectorProblem({ message: "revision対象messageがありません", status: 404, code: "feedback.not_found", retryable: false });
    const chain = orderRevisionChain(messageId, revisions);
    latest = chain.length > 0 ? { id: chain[chain.length - 1]!.marker.eventId, created: chain[chain.length - 1]!.comment.created } : undefined;
    return latest?.id ?? messageId;
  }

  private async searchAll(input: { jql: string; signal?: FeedbackRepositoryOptions["signal"] }): Promise<JiraCloudIssue[]> {
    const issues: JiraCloudIssue[] = [];
    let nextPageToken: string | undefined;
    const seenTokens = new Set<string>();
    do {
      const page = await this.client.searchIssues({
        jql: input.jql,
        maxResults: this.pageSize,
        ...(nextPageToken ? { nextPageToken } : {}),
        fields: ["summary", "status", "created", "updated"],
        properties: [jiraCloudRecoveryPropertyKey],
        signal: input.signal
      });
      issues.push(...page.issues);
      nextPageToken = page.nextPageToken ?? undefined;
      if (nextPageToken) {
        if (seenTokens.has(nextPageToken) || seenTokens.size >= 999) {
          throw new JiraCloudConnectorProblem({
            message: "Jira Cloud search paginationが循環または上限超過しました",
            status: 502,
            code: "feedback.provider_unavailable",
            retryable: false
          });
        }
        seenTokens.add(nextPageToken);
      }
    } while (nextPageToken);
    return issues;
  }

  private assertProfile(profileId: string): void {
    if (profileId !== this.config.profileId) throw integrity("provider profile bindingが一致しません");
  }

  private assertScope(scope: FeedbackRepositoryScope): void {
    this.assertProfile(scope.profileId);
    if (scope.installationId !== this.config.installationId) throw integrity("provider installation bindingが一致しません");
    assertProjectKey(scope.workspaceId);
    if (!scope.resource || typeof scope.resource.kind !== "string" || typeof scope.resource.key !== "string") throw invalid("resource scopeが不正です");
  }

  private assertProviderRef(candidate: FeedbackProjectionCandidate): void {
    if (candidate.providerRef.providerKey !== "jira-cloud" || candidate.providerRef.objectId.length === 0) {
      throw integrity("Jira Cloud以外のproviderRefです");
    }
  }
}

function validateConfiguration(config: JiraCloudConnectorConfiguration): void {
  if (!config.profileId || !config.installationId || !config.application || !config.environment || !config.issueTypeId) {
    throw new Error("Jira Cloud Connector設定が不足しています");
  }
  assertUuid(config.participantId, "participantId");
  if (!Number.isInteger(config.maximumAttachmentBytes) || config.maximumAttachmentBytes <= 0) throw new Error("maximumAttachmentBytesが不正です");
  if (config.attachmentContentTypes.length === 0 || config.attachmentContentTypes.some((type) => type.length === 0)) throw new Error("attachmentContentTypesが不正です");
  if (config.pageSize !== undefined && (!Number.isInteger(config.pageSize) || config.pageSize < 1 || config.pageSize > 100)) throw new Error("pageSizeが不正です");
}

function recoverySeed(query: FeedbackRepositoryScope & { command: { threadId: string; intentId: string; requestHash: string } }): JiraCloudRecoverySeed {
  return {
    schemaVersion: "2",
    threadId: query.command.threadId,
    intentId: query.command.intentId,
    requestHash: query.command.requestHash,
    scope: { workspaceId: query.workspaceId, resource: query.resource },
    state: "recovery-seed"
  };
}

function projectionFromProperty(value: unknown, config: JiraCloudConnectorConfiguration) {
  if (!isRecord(value) || value.schemaVersion !== "2" || typeof value.threadId !== "string" || typeof value.intentId !== "string" ||
    !uuid.test(value.threadId) || !uuid.test(value.intentId) || typeof value.requestHash !== "string" || !hash.test(value.requestHash) ||
    !isRecord(value.scope) || typeof value.scope.workspaceId !== "string" || value.scope.workspaceId.length === 0 ||
    !isResource(value.scope.resource) || (value.state !== "recovery-seed" && value.state !== "bound")) {
    throw integrity("Jira projection propertyが不正です");
  }
  const envelope = envelopeFromRecovery(value);
  let profileId = config.profileId;
  if (value.state === "bound") {
    if (!isRecord(envelope) || !isRecord(envelope.providerBinding) || typeof envelope.providerBinding.profileId !== "string") {
      throw integrity("bound Jira projectionにprovider bindingがありません");
    }
    profileId = envelope.providerBinding.profileId;
  }
  return {
    schemaVersion: "2" as const,
    threadId: value.threadId,
    intentId: value.intentId,
    requestHash: value.requestHash,
    profileId,
    workspaceId: value.scope.workspaceId,
    resource: value.scope.resource
  };
}

function envelopeFromRecovery(value: unknown): unknown | null {
  if (!isRecord(value) || value.state !== "bound") return null;
  return value.envelope ?? null;
}

function recoveryMatches(value: unknown, query: Parameters<FeedbackRepositoryPort["recoverIntent"]>[0]): boolean {
  if (!isRecord(value) || !isRecord(value.scope) || !isResource(value.scope.resource)) return false;
  return value.schemaVersion === "2" && value.threadId === query.threadId && value.intentId === query.intentId &&
    value.requestHash === query.requestHash && value.scope.workspaceId === query.workspaceId &&
    value.scope.resource.kind === query.resource.kind && value.scope.resource.key === query.resource.key;
}

function bindingContext(scope: FeedbackRepositoryScope, issueId: string) {
  return { profileId: scope.profileId, installationId: scope.installationId, objectId: issueId };
}

function markerMatches(value: unknown, intentId: string, requestHash: string): boolean {
  return isRecord(value) && value.intentId === intentId && value.requestHash === requestHash;
}

function markerKind(value: unknown): unknown {
  return isRecord(value) ? value.eventKind : undefined;
}

type RevisionEvent = {
  comment: JiraCloudComment;
  marker: {
    eventId: string;
    eventKind: "reply" | "revision";
    messageId: string;
    expectedRevisionId?: string;
    participantId: string;
    bodyHash: string;
  };
};

function assertCommentBodyHash(comment: JiraCloudComment, marker: unknown): void {
  if (!isRecord(marker) || typeof marker.bodyHash !== "string" ||
    marker.bodyHash !== calculateFeedbackCommandHash({ body: adfToText(comment.body) })) {
    throw integrity("Jira comment本文が署名済みbodyHashと一致しません");
  }
}

function orderRevisionChain(messageId: string, events: readonly RevisionEvent[]): RevisionEvent[] {
  const byExpected = new Map<string, RevisionEvent[]>();
  const eventIds = new Set<string>();
  for (const event of events) {
    if (!event.marker.expectedRevisionId) throw integrity("revision markerにexpectedRevisionIdがありません");
    if (eventIds.has(event.marker.eventId) || event.marker.eventId === messageId) throw integrity("revision eventIdが重複しています");
    eventIds.add(event.marker.eventId);
    const candidates = byExpected.get(event.marker.expectedRevisionId) ?? [];
    candidates.push(event);
    byExpected.set(event.marker.expectedRevisionId, candidates);
  }
  const ordered: RevisionEvent[] = [];
  const visited = new Set<string>([messageId]);
  let expected = messageId;
  for (;;) {
    const candidates = byExpected.get(expected) ?? [];
    if (candidates.length === 0) break;
    if (candidates.length !== 1) throw integrity("revision chainが分岐しています");
    const event = candidates[0]!;
    if (visited.has(event.marker.eventId)) throw integrity("revision chainが循環しています");
    visited.add(event.marker.eventId);
    ordered.push(event);
    expected = event.marker.eventId;
  }
  if (ordered.length !== events.length) throw integrity("revision chainが連続していません");
  return ordered;
}

function inlineProperty(properties: readonly unknown[] | undefined, key: string): unknown | undefined {
  if (!properties) return undefined;
  const match = properties.find((value) => isRecord(value) && value.key === key);
  return isRecord(match) ? match.value : undefined;
}

function providerRef(issue: JiraCloudIssue) {
  return { providerKey: "jira-cloud", objectId: issue.id, eventId: issue.key };
}

function textToAdf(body: string): unknown {
  const lines = body.split("\n");
  return {
    type: "doc",
    version: 1,
    content: lines.map((line) => ({ type: "paragraph", content: line.length === 0 ? [] : [{ type: "text", text: line }] }))
  };
}

function adfToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "";
  if (value.type === "text" && typeof value.text === "string") return value.text;
  if (value.type === "hardBreak") return "\n";
  if (!Array.isArray(value.content)) return "";
  const separator = value.type === "doc" ? "\n" : "";
  const text = value.content.map(adfToText).join(separator);
  return text;
}

function messageFromComment(comment: JiraCloudComment, marker: Record<string, unknown>, currentParticipantId: string): FeedbackMessage {
  const messageId = String(marker.messageId);
  const eventId = String(marker.eventId);
  return {
    messageId,
    body: adfToText(comment.body),
    author: {
      kind: "participant",
      participantId: String(marker.participantId),
      displayName: "Participant",
      isCurrentParticipant: marker.participantId === currentParticipantId
    },
    createdAt: comment.created,
    orderingKey: { occurredAt: comment.created, eventId },
    revisions: [],
    attachments: []
  };
}

function messageFromRevision(comment: JiraCloudComment, marker: Record<string, unknown>, currentParticipantId: string): FeedbackMessage {
  const message = messageFromComment(comment, marker, currentParticipantId);
  message.revisions = [{ revisionId: String(marker.eventId), body: message.body, revisedAt: comment.created, orderingKey: message.orderingKey }];
  return message;
}

function providerMessage(comment: JiraCloudComment, messageId: string): FeedbackMessage {
  const author = isRecord(comment.author) && typeof comment.author.displayName === "string" ? comment.author.displayName : "Unknown";
  return {
    messageId,
    body: adfToText(comment.body),
    author: author === "Unknown" ? { kind: "unknown", displayName: "Unknown" } : { kind: "provider-user", displayName: author },
    createdAt: comment.created,
    orderingKey: { occurredAt: comment.created, eventId: messageId },
    revisions: [],
    attachments: []
  };
}

function attachmentFromMarker(marker: {
  attachmentId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}): FeedbackAttachment {
  return {
    attachmentId: marker.attachmentId,
    filename: marker.filename,
    contentType: marker.contentType,
    sizeBytes: marker.sizeBytes,
    createdAt: marker.createdAt
  };
}

function attachmentMessageId(marker: unknown): string {
  if (!isRecord(marker) || typeof marker.messageId !== "string" || !uuid.test(marker.messageId)) {
    throw integrity("attachment markerにmessageIdがありません");
  }
  return marker.messageId;
}

function envelopeParticipant(envelope: Record<string, unknown>, currentParticipantId: string): FeedbackMessage["author"] {
  if (isRecord(envelope.createdBy) && typeof envelope.createdBy.participantId === "string") {
    return {
      kind: "participant",
      participantId: envelope.createdBy.participantId,
      displayName: "Participant",
      isCurrentParticipant: envelope.createdBy.participantId === currentParticipantId
    };
  }
  return { kind: "unknown", displayName: "Unknown" };
}

function storedResource(envelope: Record<string, unknown>): { kind: string; key: string } {
  if (isRecord(envelope.scope) && isResource(envelope.scope.resource)) return envelope.scope.resource;
  return { kind: "unknown", key: "unknown" };
}

function issueClosed(value: unknown): boolean {
  return isRecord(value) && isRecord(value.statusCategory) && value.statusCategory.key === "done";
}

function dateString(value: unknown): string {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  throw new JiraCloudConnectorProblem({
    message: "Jira Cloud timestampが不正です",
    status: 502,
    code: "feedback.provider_unavailable",
    retryable: false
  });
}

function compareOrdering(left: { occurredAt: string; eventId: string }, right: { occurredAt: string; eventId: string }): number {
  const timestamp = left.occurredAt.localeCompare(right.occurredAt);
  return timestamp === 0 ? left.eventId.localeCompare(right.eventId) : timestamp;
}

function stableId(kind: string, providerId: string): string {
  const hex = calculateFeedbackCommandHash({ provider: "jira-cloud", kind, providerId }).slice("sha256:".length, "sha256:".length + 32).split("");
  hex[12] = "5";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16]!, 16) & 3]!;
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function attachmentPropertyKey(attachmentId: string): string {
  assertUuid(attachmentId, "attachmentId");
  return `${jiraCloudAttachmentPropertyPrefix}${attachmentId}`;
}

type RecoveryQuery<TOperation extends FeedbackRecoverableOperation> = FeedbackRepositoryScope & {
  threadId: string;
  intentId: string;
  requestHash: string;
  operation: TOperation;
};

function recoveryQuery<TOperation extends FeedbackRecoverableOperation>(
  query: FeedbackRepositoryScope & { threadId?: string; command: { threadId?: string; intentId: string; requestHash: string } },
  operation: TOperation
): RecoveryQuery<TOperation> {
  const threadId = query.threadId ?? query.command.threadId;
  if (!threadId) throw invalid("recovery threadIdがありません");
  return {
    profileId: query.profileId,
    installationId: query.installationId,
    workspaceId: query.workspaceId,
    resource: query.resource,
    threadId,
    intentId: query.command.intentId,
    requestHash: query.command.requestHash,
    operation
  };
}

function completed<TOperation extends FeedbackRecoverableOperation>(
  intentId: string,
  operation: TOperation,
  stableResultId: string
): FeedbackIntentRecoveryResultFor<TOperation> {
  return { intentId, state: "completed", operation, stableResultId } as FeedbackIntentRecoveryResultFor<TOperation>;
}

function pending<TOperation extends FeedbackRecoverableOperation>(
  intentId: string,
  operation: TOperation,
  retryAfterSeconds: number
): FeedbackIntentRecoveryResultFor<TOperation> {
  return { intentId, state: "pending", operation, retryAfterSeconds, automaticWriteAllowed: false } as FeedbackIntentRecoveryResultFor<TOperation>;
}

function repair<TOperation extends FeedbackRecoverableOperation>(
  intentId: string,
  operation: TOperation,
  detail: string,
  retryDirective: "recover-only" | "manual-confirmation" | "do-not-write"
): FeedbackIntentRecoveryResultFor<TOperation> {
  return { intentId, state: "repair_required", operation, detail, automaticWriteAllowed: false, retryDirective } as FeedbackIntentRecoveryResultFor<TOperation>;
}

function unknownWriteResult(error: unknown): boolean {
  return error instanceof JiraCloudConnectorProblem && error.resultUnknown;
}

function recoverableMetadataFailure(error: unknown): boolean {
  return error instanceof JiraCloudConnectorProblem && (error.resultUnknown || error.status >= 500 || error.status === 429);
}

function invalid(message: string): JiraCloudConnectorProblem {
  return new JiraCloudConnectorProblem({ message, status: 400, code: "feedback.invalid_request", retryable: false });
}

function integrity(message: string): JiraCloudConnectorProblem {
  return new JiraCloudConnectorProblem({ message, status: 502, code: "feedback.integrity_error", retryable: false });
}

function assertUuid(value: string, label: string): void {
  if (!uuid.test(value)) throw invalid(`${label}がUUIDではありません`);
}

function assertHash(value: string): void {
  if (!hash.test(value)) throw invalid("requestHashが不正です");
}

function assertProjectKey(value: string): void {
  if (!projectKey.test(value)) throw invalid("workspaceIdはJira project keyではありません");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResource(value: unknown): value is { kind: string; key: string } {
  return isRecord(value) && typeof value.kind === "string" && value.kind.length > 0 &&
    typeof value.key === "string" && value.key.length > 0;
}

function offsetCursor(fingerprint: string, offset: number): string {
  return tokenCursor(fingerprint, String(offset));
}

function readOffsetCursor(cursor: string | undefined, fingerprint: string): number {
  const value = readTokenCursor(cursor, fingerprint);
  if (value === undefined) return 0;
  if (!/^(?:0|[1-9][0-9]{0,11})$/u.test(value)) throw invalid("cursor offsetが不正です");
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0) throw invalid("cursor offsetが不正です");
  return offset;
}

function tokenCursor(fingerprint: string, token: string): string {
  if (token.length === 0 || token.length > 2048) throw invalid("cursor tokenが不正です");
  return `jira-v3.${encodeURIComponent(fingerprint)}.${encodeURIComponent(token)}`;
}

function readTokenCursor(cursor: string | undefined, fingerprint: string): string | undefined {
  if (cursor === undefined) return undefined;
  const match = /^jira-v3\.([^.]*)\.(.*)$/u.exec(cursor);
  if (!match) throw invalid("cursor形式が不正です");
  try {
    const decodedFingerprint = decodeURIComponent(match[1]!);
    const token = decodeURIComponent(match[2]!);
    if (decodedFingerprint !== fingerprint) throw invalid("cursor query fingerprintが一致しません");
    if (token.length === 0 || token.length > 2048) throw invalid("cursor tokenが不正です");
    return token;
  } catch (error) {
    if (error instanceof JiraCloudConnectorProblem) throw error;
    throw invalid("cursor encodingが不正です");
  }
}

async function* verifiedContentStream(
  body: AsyncIterable<Uint8Array>,
  expectedBytes: number,
  expectedHash: string
): AsyncIterable<Uint8Array> {
  const digest = createHash("sha256");
  let actualBytes = 0;
  for await (const chunk of body) {
    actualBytes += chunk.byteLength;
    if (actualBytes > expectedBytes) throw integrity("Jira attachment responseが署名済みsizeを超えました");
    digest.update(chunk);
    yield chunk;
  }
  if (actualBytes !== expectedBytes) throw integrity("Jira attachment response sizeが署名mappingと一致しません");
  if (`sha256:${digest.digest("hex")}` !== expectedHash) {
    throw integrity("Jira attachment contentが署名済みhashと一致しません");
  }
}
