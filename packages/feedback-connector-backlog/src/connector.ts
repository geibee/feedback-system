import type {
  FeedbackIntentRecoveryResultFor,
  FeedbackProjectionCandidate,
  FeedbackRecoverableOperation,
  FeedbackRepositoryOptions,
  FeedbackRepositoryPort,
  FeedbackRepositoryScope
} from "@geibee/feedback-connector-sdk";
import { calculateFeedbackCommandHash, type FeedbackEnvelopeCodecPort } from "@geibee/feedback-envelope";
import { BacklogRestV2Client, type BacklogComment, type BacklogIssue } from "./rest-v2-client.js";
import {
  BacklogConnectorProblem,
  backlogMarkerNames,
  type BacklogConnectorConfiguration,
  type BacklogTransport
} from "./types.js";

type FeedbackCapabilities = Awaited<ReturnType<FeedbackRepositoryPort["getCapabilities"]>>;
type FeedbackThread = Awaited<ReturnType<FeedbackRepositoryPort["readCandidate"]>>["thread"];
type FeedbackMessage = FeedbackThread["messages"][number];
type FeedbackIntentRecoveryResult = Awaited<ReturnType<FeedbackRepositoryPort["recoverIntent"]>>;
type FeedbackThreadCommandResult = Extract<Awaited<ReturnType<FeedbackRepositoryPort["createThread"]>>, { disposition: string }>;
type FeedbackMessageCommandResult = Extract<Awaited<ReturnType<FeedbackRepositoryPort["reply"]>>, { disposition: string }>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const hash = /^sha256:[a-f0-9]{64}$/u;

export type BacklogConnectorOptions = {
  configuration: BacklogConnectorConfiguration;
  transport: BacklogTransport;
  envelopeCodec: FeedbackEnvelopeCodecPort;
  now?: () => Date;
};

/** request participantごとに生成し、Backlog固有wireをclient内へ閉じ込める。 */
export function createFeedbackBacklogConnector(options: BacklogConnectorOptions): FeedbackRepositoryPort {
  return new FeedbackBacklogConnector(options);
}

class FeedbackBacklogConnector implements FeedbackRepositoryPort {
  readonly config: Readonly<BacklogConnectorConfiguration>;
  readonly client: BacklogRestV2Client;
  readonly codec: FeedbackEnvelopeCodecPort;
  readonly now: () => Date;
  readonly pageSize: number;

  constructor(options: BacklogConnectorOptions) {
    validateConfiguration(options.configuration);
    this.config = Object.freeze({
      ...options.configuration,
      customFieldIds: Object.freeze({ ...options.configuration.customFieldIds })
    });
    this.client = new BacklogRestV2Client(options.transport);
    this.codec = options.envelopeCodec;
    this.now = options.now ?? (() => new Date());
    this.pageSize = options.configuration.pageSize ?? 100;
  }

  async getCapabilities(): Promise<FeedbackCapabilities> {
    return {
      backendOperations: ["feedback:read", "feedback:create", "feedback:reply", "feedback:revise"],
      discovery: { workspaces: "supported", resources: "unsupported" },
      operationGuarantees: {
        create: "recoverable",
        reply: "recoverable",
        revision: "recoverable",
        attachmentUpload: "unsupported"
      },
      creationFields: [],
      maximumAttachmentBytes: 1,
      attachmentContentTypes: []
    };
  }

  async listWorkspaces(profileId: string, cursor?: string, options?: FeedbackRepositoryOptions) {
    this.assertProfile(profileId);
    if (cursor) throw invalid("Backlog単一workspace profileにcursorはありません");
    const project = await this.client.getProject(this.config.projectId, options?.signal);
    if (project.archived || project.projectKey !== this.config.workspaceId) throw integrity("Backlog project bindingが一致しません");
    return { items: [{ workspaceId: project.projectKey, displayName: project.name }], nextCursor: null };
  }

  async listResources(): Promise<never> {
    throw unsupported("Backlogはhost resource discoveryを公開しません");
  }

  async findThreadCandidates(
    query: FeedbackRepositoryScope & { cursor?: string; order?: "updated_desc" | "updated_asc" },
    options?: FeedbackRepositoryOptions
  ) {
    this.assertScope(query);
    const fingerprint = calculateFeedbackCommandHash({
      operation: "backlog-find-threads",
      profileId: query.profileId,
      workspaceId: query.workspaceId,
      resource: query.resource,
      order: query.order ?? "updated_desc"
    });
    const offset = readCursor(query.cursor, fingerprint);
    const issues = await this.client.searchIssues({
      projectId: this.config.projectId,
      customFieldId: this.config.customFieldIds.resourceKey,
      customFieldValue: resourceProjection(this.config, query.resource),
      offset,
      count: this.pageSize,
      order: query.order === "updated_asc" ? "asc" : "desc",
      signal: options?.signal
    });
    const candidates = issues.flatMap((issue) => {
      if (customFieldText(issue, this.config.customFieldIds.resourceKey) !== resourceProjection(this.config, query.resource)) return [];
      const projection = projectionFromIssue(issue, this.config);
      return projectionMatches(projection, query) ? [{ providerRef: providerRef(issue), projection }] : [];
    });
    return {
      candidates,
      nextCursor: issues.length === this.pageSize ? cursor(offset + issues.length, fingerprint) : null
    };
  }

  readonly supportsThreadReferences = true as const;

  async findThreadCandidatesById(
    query: FeedbackRepositoryScope & { threadId: string },
    options?: FeedbackRepositoryOptions
  ): Promise<FeedbackProjectionCandidate[]> {
    this.assertScope(query);
    assertUuid(query.threadId, "threadId");
    if (options?.threadRef) {
      this.assertProviderRef({ providerRef: options.threadRef } as FeedbackProjectionCandidate);
      const issue = await this.client.getIssue(options.threadRef.objectId, options.signal);
      if (String(issue.id) !== options.threadRef.objectId) throw integrity("参照先が別ticketへ変わりました");
      await this.assertBoundEnvelope(parseBlock(issue.description, backlogMarkerNames.envelope), query, issue.id);
      const projection = projectionFromIssue(issue, this.config);
      if (!projectionMatches(projection, query) || projection.threadId !== query.threadId) throw integrity("参照先のprojection bindingが不正です");
      return [{ providerRef: providerRef(issue), projection }];
    }
    const issues = await this.searchAll({
      customFieldId: this.config.customFieldIds.threadId,
      value: query.threadId,
      order: "asc",
      signal: options?.signal
    });
    return issues.flatMap((issue) => {
      if (customFieldText(issue, this.config.customFieldIds.threadId) !== query.threadId) return [];
      const projection = projectionFromIssue(issue, this.config);
      return projectionMatches(projection, query) ? [{ providerRef: providerRef(issue), projection }] : [];
    });
  }

  async readCandidate(candidate: FeedbackProjectionCandidate, options?: FeedbackRepositoryOptions) {
    this.assertProviderRef(candidate);
    const issue = await this.client.getIssue(candidate.providerRef.objectId, options?.signal);
    const seed = recoverySeedFromIssue(issue);
    const envelope = parseBlock(issue.description, backlogMarkerNames.envelope);
    const comments = await this.client.getAllComments(issue.id, this.pageSize, options?.signal);
    const thread = await this.mapThread(issue, envelope, comments);
    return {
      providerRef: providerRef(issue),
      envelope,
      legacyMetadata: {
        provider: "backlog",
        recoverySeed: seed,
        commentMarkers: comments.flatMap((comment) => {
          const marker = parseBlock(comment.content, backlogMarkerNames.message);
          return marker ? [{ providerCommentId: String(comment.id), marker }] : [];
        })
      },
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
    if (!sameResource(query.command.resource, query.resource)) throw invalid("create command resourceがscopeと一致しません");
    const seed = recoverySeed(query);
    const description = carrier(query.command.body, backlogMarkerNames.recovery, seed);
    assertMetadataSize(description, this.config.maximumMetadataBytes);
    let created: BacklogIssue;
    try {
      created = await this.client.createIssue({
        projectId: this.config.projectId,
        summary: query.command.title,
        description,
        issueTypeId: this.config.issueTypeId,
        priorityId: this.config.priorityId,
        customFields: {
          [this.config.customFieldIds.threadId]: query.command.threadId,
          [this.config.customFieldIds.intentId]: query.command.intentId,
          [this.config.customFieldIds.requestHash]: query.command.requestHash,
          [this.config.customFieldIds.resourceKey]: resourceProjection(this.config, query.resource)
        },
        signal: options?.signal
      });
    } catch (error) {
      if (!unknownWriteResult(error)) throw error;
      return this.recoverCreate(recoveryQuery(query, "feedback:create"), options);
    }
    try {
      await this.bindEnvelope(created, query, seed, options, query.command.body);
      const reread = await this.client.getIssue(created.id, options?.signal);
      const projection = projectionFromIssue(reread, this.config);
      const record = await this.readCandidate({ providerRef: providerRef(reread), projection }, options);
      options?.onThreadResolved?.(record.providerRef);
      return { disposition: "created", intentId: query.command.intentId, thread: record.thread };
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
    const prior = await this.recoverCommentIntent(resolved.issue, query, "feedback:reply", query.command.intentId, query.command.requestHash, options);
    if (prior.state !== "not_found") return prior;
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
      providerBinding: bindingContext(query, resolved.issue.id),
      createdAt: this.now().toISOString()
    });
    const content = carrier(query.command.body, backlogMarkerNames.message, marker);
    assertMetadataSize(content, this.config.maximumMetadataBytes);
    try {
      const comment = await this.client.addComment(resolved.issue.id, content, options?.signal);
      await this.assertMessageComment(comment, marker, query, resolved.issue.id);
      return { disposition: "created", intentId: query.command.intentId, message: messageFromComment(comment, marker, this.config.participantId) };
    } catch (error) {
      if (!unknownWriteResult(error)) throw error;
      const recovery = await this.recoverCommentIntent(resolved.issue, query, "feedback:reply", query.command.intentId, query.command.requestHash, options);
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
    const prior = await this.recoverCommentIntent(resolved.issue, query, "feedback:revise", query.command.intentId, query.command.requestHash, options);
    if (prior.state !== "not_found") return prior;
    const comments = await this.client.getAllComments(resolved.issue.id, this.pageSize, options?.signal);
    const latest = await this.latestRevisionId(query.messageId, query, resolved.issue.id, comments);
    if (latest !== query.command.expectedRevisionId) {
      throw new BacklogConnectorProblem({ message: "Backlog revisionが競合しました", status: 409, code: "feedback.conflict", retryable: false });
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
      providerBinding: bindingContext(query, resolved.issue.id),
      createdAt: this.now().toISOString()
    });
    const content = carrier(query.command.body, backlogMarkerNames.message, marker);
    assertMetadataSize(content, this.config.maximumMetadataBytes);
    try {
      const comment = await this.client.addComment(resolved.issue.id, content, options?.signal);
      await this.assertMessageComment(comment, marker, query, resolved.issue.id);
      return { disposition: "created", intentId: query.command.intentId, message: messageFromRevision(comment, marker, this.config.participantId) };
    } catch (error) {
      if (!unknownWriteResult(error)) throw error;
      const recovery = await this.recoverCommentIntent(resolved.issue, query, "feedback:revise", query.command.intentId, query.command.requestHash, options);
      return recovery.state === "completed" ? recovery : repair(query.command.intentId, "feedback:revise", "revision結果を一意に確認できません", "do-not-write");
    }
  }

  async recoverIntent(query: Parameters<FeedbackRepositoryPort["recoverIntent"]>[0], options?: FeedbackRepositoryOptions): Promise<FeedbackIntentRecoveryResult> {
    this.assertScope(query);
    assertUuid(query.threadId, "threadId");
    assertUuid(query.intentId, "intentId");
    assertHash(query.requestHash);
    if (query.operation === "feedback:create") return this.recoverCreate({ ...query, operation: "feedback:create" }, options);
    if (query.operation === "feedback:attachment:upload") return repair(query.intentId, query.operation, "Backlog attachmentは未対応です", "do-not-write");
    const resolved = await this.resolveThread(query, query.operation, query.intentId, options);
    if (!("issue" in resolved)) return resolved;
    return this.recoverCommentIntent(resolved.issue, query, query.operation, query.intentId, query.requestHash, options);
  }

  async uploadAttachment(): Promise<never> {
    throw unsupported("Backlog attachment uploadは署名済み最終ID bindingを作れないため未対応です");
  }

  async getAttachment(): Promise<never> {
    throw unsupported("Backlog attachment readは署名済み最終ID bindingを作れないため未対応です");
  }

  private get retryAfter(): number { return this.config.recoveryRetryAfterSeconds ?? 5; }

  private async recoverCreate(
    query: RecoveryQuery<"feedback:create">,
    options?: FeedbackRepositoryOptions
  ): Promise<FeedbackIntentRecoveryResultFor<"feedback:create">> {
    const candidates = await this.findThreadCandidatesById(query, options);
    if (candidates.length === 0) return pending(query.intentId, query.operation, this.retryAfter);
    if (candidates.length > 1) return repair(query.intentId, query.operation, "同じthreadIdのBacklog issueが複数あります", "do-not-write");
    const issue = await this.client.getIssue(candidates[0]!.providerRef.objectId, options?.signal);
    const seed = recoverySeedFromIssue(issue);
    if (!recoveryMatches(seed, query)) return repair(query.intentId, query.operation, "recovery tripletまたはscopeが一致しません", "do-not-write");
    const envelope = parseBlock(issue.description, backlogMarkerNames.envelope);
    if (envelope) {
      await this.assertBoundEnvelope(envelope, query, issue.id);
      options?.onThreadResolved?.(providerRef(issue));
      return completed(query.intentId, query.operation, query.threadId);
    }
    await this.bindEnvelope(issue, query, seed, options);
    const reread = await this.client.getIssue(issue.id, options?.signal);
    await this.assertBoundEnvelope(parseBlock(reread.description, backlogMarkerNames.envelope), query, issue.id);
    options?.onThreadResolved?.(providerRef(issue));
    return completed(query.intentId, query.operation, query.threadId);
  }

  private async bindEnvelope(
    issue: BacklogIssue,
    scope: FeedbackRepositoryScope & { threadId?: string; command?: { threadId?: string; intentId: string; requestHash: string } },
    seed: RecoverySeed,
    options?: FeedbackRepositoryOptions,
    originalBody?: string
  ): Promise<void> {
    const envelope = await this.codec.signEnvelope({
      schemaVersion: "2",
      threadId: seed.threadId,
      intentId: seed.intentId,
      requestHash: seed.requestHash,
      ...(originalBody === undefined ? {} : { initialBodyHash: calculateFeedbackCommandHash({ body: originalBody }) }),
      providerBinding: bindingContext(scope, issue.id),
      scope: {
        workspace: scope.workspaceId,
        resource: scope.resource,
        application: this.config.application,
        environment: this.config.environment
      },
      createdBy: { participantId: this.config.participantId },
      createdAt: this.now().toISOString()
    });
    const description = `${carrier(visibleBody(issue.description), backlogMarkerNames.recovery, seed)}\n\n${block(backlogMarkerNames.envelope, envelope)}`;
    assertMetadataSize(description, this.config.maximumMetadataBytes);
    await this.client.updateIssueDescription(issue.id, description, options?.signal);
    const reread = await this.client.getIssue(issue.id, options?.signal);
    await this.assertBoundEnvelope(parseBlock(reread.description, backlogMarkerNames.envelope), scope, issue.id);
  }

  private async resolveThread<TOperation extends "feedback:reply" | "feedback:revise" | "feedback:attachment:upload">(
    query: FeedbackRepositoryScope & { threadId: string },
    operation: TOperation,
    intentId: string,
    options?: FeedbackRepositoryOptions
  ): Promise<{ issue: BacklogIssue; envelope: unknown } | FeedbackIntentRecoveryResultFor<TOperation>> {
    const candidates = await this.findThreadCandidatesById(query, options);
    if (candidates.length === 0) return pending(intentId, operation, this.retryAfter);
    if (candidates.length > 1) return repair(intentId, operation, "同じthreadIdのBacklog issueが複数あります", "do-not-write");
    const issue = await this.client.getIssue(candidates[0]!.providerRef.objectId, options?.signal);
    const envelope = parseBlock(issue.description, backlogMarkerNames.envelope);
    await this.assertBoundEnvelope(envelope, query, issue.id);
    options?.onThreadResolved?.(providerRef(issue));
    return { issue, envelope };
  }

  private async assertBoundEnvelope(envelope: unknown, scope: FeedbackRepositoryScope & { threadId?: string }, issueId: number): Promise<void> {
    const verification = await this.codec.verifyEnvelope(envelope, bindingContext(scope, issueId));
    if (!verification.valid) throw integrity(`Backlog Envelope検証失敗: ${verification.reason}`);
    if ((scope.threadId && verification.value.threadId !== scope.threadId) ||
      verification.value.scope.workspace !== scope.workspaceId || !sameResource(verification.value.scope.resource, scope.resource) ||
      verification.value.scope.application !== this.config.application || verification.value.scope.environment !== this.config.environment) {
      throw integrity("Backlog Envelope scopeが一致しません");
    }
  }

  private async recoverCommentIntent<TOperation extends "feedback:reply" | "feedback:revise">(
    issue: BacklogIssue,
    scope: FeedbackRepositoryScope & { threadId: string },
    operation: TOperation,
    intentId: string,
    requestHash: string,
    options?: FeedbackRepositoryOptions
  ): Promise<FeedbackIntentRecoveryResultFor<TOperation>> {
    const expectedKind = operation === "feedback:reply" ? "reply" : "revision";
    const comments = await this.client.getAllComments(issue.id, this.pageSize, options?.signal);
    const matches = comments.flatMap((comment) => {
      const marker = parseBlock(comment.content, backlogMarkerNames.message);
      return isRecord(marker) && marker.intentId === intentId && marker.requestHash === requestHash && marker.eventKind === expectedKind
        ? [{ comment, marker }]
        : [];
    });
    if (matches.length === 0) return { intentId, state: "not_found", operation } as FeedbackIntentRecoveryResultFor<TOperation>;
    if (matches.length > 1) return repair(intentId, operation, "同じintentのBacklog commentが複数あります", "do-not-write");
    const verification = await this.codec.verifyMessageMarker(matches[0]!.marker, bindingContext(scope, issue.id));
    if (!verification.valid || verification.value.threadId !== scope.threadId) throw integrity("Backlog message markerが不正です");
    assertCommentBodyHash(matches[0]!.comment, verification.value);
    return completed(intentId, operation, verification.value.eventId);
  }

  private async assertMessageComment(comment: BacklogComment, marker: unknown, scope: FeedbackRepositoryScope & { threadId: string }, issueId: number): Promise<void> {
    const reread = parseBlock(comment.content, backlogMarkerNames.message);
    const verification = await this.codec.verifyMessageMarker(reread, bindingContext(scope, issueId));
    if (!verification.valid || verification.value.threadId !== scope.threadId || !sameMarkerIdentity(verification.value, marker)) {
      throw integrity("Backlog comment markerのround-tripが不正です");
    }
    assertCommentBodyHash(comment, verification.value);
  }

  private async latestRevisionId(messageId: string, scope: FeedbackRepositoryScope & { threadId: string }, issueId: number, comments: readonly BacklogComment[]): Promise<string> {
    let messageExists = messageId === scope.threadId;
    const revisions: RevisionEvent[] = [];
    for (const comment of comments) {
      const marker = parseBlock(comment.content, backlogMarkerNames.message);
      if (!marker) continue;
      const verification = await this.codec.verifyMessageMarker(marker, bindingContext(scope, issueId));
      if (!verification.valid || verification.value.threadId !== scope.threadId) throw integrity("revision確認中のBacklog markerが不正です");
      assertCommentBodyHash(comment, verification.value);
      if (verification.value.eventKind === "reply" && verification.value.messageId === messageId) messageExists = true;
      if (verification.value.eventKind === "revision" && verification.value.messageId === messageId) revisions.push({ comment, marker: verification.value });
    }
    if (!messageExists) throw new BacklogConnectorProblem({ message: "revision対象messageがありません", status: 404, code: "feedback.not_found", retryable: false });
    const chain = orderRevisionChain(messageId, revisions);
    return chain.at(-1)?.marker.eventId ?? messageId;
  }

  private async mapThread(issue: BacklogIssue, envelope: unknown, comments: readonly BacklogComment[]): Promise<FeedbackThread> {
    if (!isRecord(envelope)) throw integrity("Backlog issueに署名済みEnvelopeがありません");
    const threadId = typeof envelope.threadId === "string" && uuid.test(envelope.threadId) ? envelope.threadId : stableId("issue", issue.id);
    const initial: FeedbackMessage = {
      messageId: threadId,
      body: visibleBody(issue.description),
      author: envelope.initialBodyHash ? envelopeParticipant(envelope, this.config.participantId)
        : { kind: "provider-user", displayName: "Backlog user" },
      createdAt: issue.created,
      orderingKey: { occurredAt: issue.created, eventId: threadId },
      revisions: [],
      attachments: []
    };
    const messages = new Map<string, FeedbackMessage>([[threadId, initial]]);
    if (envelope.initialBodyHash !== undefined && envelope.initialBodyHash !== calculateFeedbackCommandHash({ body: initial.body })) {
      throw integrity("Backlog initial本文が署名済みhashと一致しません");
    }
    const revisions = new Map<string, RevisionEvent[]>();
    for (const comment of comments) {
      const marker = parseBlock(comment.content, backlogMarkerNames.message);
      if (!marker) {
        if (visibleBody(comment.content).length > 0) {
          const messageId = stableId("comment", comment.id);
          messages.set(messageId, providerMessage(comment, messageId));
        }
        continue;
      }
      const verification = await this.codec.verifyMessageMarker(marker, {
        profileId: this.config.profileId,
        installationId: this.config.installationId,
        objectId: String(issue.id)
      });
      if (!verification.valid || verification.value.threadId !== threadId) throw integrity("Backlog comment markerが不正です");
      assertCommentBodyHash(comment, verification.value);
      if (verification.value.eventKind === "reply") {
        if (messages.has(verification.value.messageId)) throw integrity("同じmessageIdのBacklog replyが複数あります");
        messages.set(verification.value.messageId, messageFromComment(comment, verification.value, this.config.participantId));
      } else {
        const events = revisions.get(verification.value.messageId) ?? [];
        events.push({ comment, marker: verification.value });
        revisions.set(verification.value.messageId, events);
      }
    }
    for (const [messageId, events] of revisions) {
      const target = messages.get(messageId);
      if (!target) throw integrity("Backlog revision対象messageがありません");
      const chain = orderRevisionChain(messageId, events);
      const owner = messageId === threadId ? envelopeParticipant(envelope, this.config.participantId) : target.author;
      if (owner.kind !== "participant") {
        throw integrity("Backlog revision participantが元message authorと一致しません");
      }
      const participantId = owner.participantId;
      if (chain.some((event) => event.marker.participantId !== participantId)) {
        throw integrity("Backlog revision participantが元message authorと一致しません");
      }
      target.revisions = chain.map((event) => ({
        revisionId: event.marker.eventId,
        body: visibleBody(event.comment.content),
        revisedAt: event.comment.created,
        orderingKey: { occurredAt: event.comment.created, eventId: event.marker.eventId }
      }));
      if (target.revisions.length > 0) {
        target.body = target.revisions.at(-1)!.body;
        target.author = owner;
      }
    }
    const ordered = [...messages.values()].sort((left, right) => compareOrdering(left.orderingKey, right.orderingKey));
    return {
      threadId,
      resource: storedResource(envelope),
      title: issue.summary,
      status: issueClosed(issue.status.name) ? "closed" : "open",
      createdAt: issue.created,
      updatedAt: issue.updated,
      messageCount: ordered.length,
      messages: ordered
    };
  }

  private async searchAll(input: { customFieldId: number; value: string; order: "asc" | "desc"; signal?: FeedbackRepositoryOptions["signal"] }): Promise<BacklogIssue[]> {
    const result: BacklogIssue[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.client.searchIssues({
        projectId: this.config.projectId,
        customFieldId: input.customFieldId,
        customFieldValue: input.value,
        offset,
        count: this.pageSize,
        order: input.order,
        signal: input.signal
      });
      result.push(...page);
      if (page.length < this.pageSize) return result;
      offset += page.length;
      if (offset > 10_000) throw new BacklogConnectorProblem({ message: "Backlog search paginationが上限を超えました", status: 502, code: "feedback.provider_unavailable", retryable: false });
    }
  }

  private assertProfile(profileId: string): void { if (profileId !== this.config.profileId) throw integrity("Backlog profile bindingが一致しません"); }
  private assertScope(scope: FeedbackRepositoryScope): void {
    this.assertProfile(scope.profileId);
    if (scope.installationId !== this.config.installationId || scope.workspaceId !== this.config.workspaceId) throw integrity("Backlog scope bindingが一致しません");
    if (!scope.resource || typeof scope.resource.kind !== "string" || typeof scope.resource.key !== "string") throw invalid("resource scopeが不正です");
  }
  private assertProviderRef(candidate: FeedbackProjectionCandidate): void {
    if (candidate.providerRef.providerKey !== "backlog" || !/^[1-9][0-9]*$/u.test(candidate.providerRef.objectId)) throw integrity("Backlog providerRefが不正です");
  }
}

type RecoverySeed = {
  schemaVersion: "2";
  threadId: string;
  intentId: string;
  requestHash: string;
  scope: { workspaceId: string; resource: { kind: string; key: string } };
  state: "recovery-seed";
};

type RevisionEvent = {
  comment: BacklogComment;
  marker: { eventId: string; eventKind: "reply" | "revision"; messageId: string; expectedRevisionId?: string; participantId: string; bodyHash: string };
};

function recoverySeed(query: FeedbackRepositoryScope & { command: { threadId: string; intentId: string; requestHash: string } }): RecoverySeed {
  return { schemaVersion: "2", threadId: query.command.threadId, intentId: query.command.intentId, requestHash: query.command.requestHash, scope: { workspaceId: query.workspaceId, resource: query.resource }, state: "recovery-seed" };
}

function recoverySeedFromIssue(issue: BacklogIssue): RecoverySeed {
  const seed = parseBlock(issue.description, backlogMarkerNames.recovery);
  if (!isRecoverySeed(seed)) throw integrity("Backlog recovery seedが不正です");
  return seed;
}

function projectionFromIssue(issue: BacklogIssue, config: BacklogConnectorConfiguration) {
  const seed = recoverySeedFromIssue(issue);
  if (customFieldText(issue, config.customFieldIds.threadId) !== seed.threadId ||
    customFieldText(issue, config.customFieldIds.intentId) !== seed.intentId ||
    customFieldText(issue, config.customFieldIds.requestHash) !== seed.requestHash ||
    customFieldText(issue, config.customFieldIds.resourceKey) !== resourceProjection(config, seed.scope.resource)) {
    throw integrity("Backlog search projectionとrecovery seedが一致しません");
  }
  return { schemaVersion: "2" as const, threadId: seed.threadId, intentId: seed.intentId, requestHash: seed.requestHash, profileId: config.profileId, workspaceId: seed.scope.workspaceId, resource: seed.scope.resource };
}

function projectionMatches(projection: ReturnType<typeof projectionFromIssue>, scope: FeedbackRepositoryScope): boolean {
  return projection.profileId === scope.profileId && projection.workspaceId === scope.workspaceId && sameResource(projection.resource, scope.resource);
}

function recoveryMatches(seed: RecoverySeed, query: RecoveryQuery<"feedback:create">): boolean {
  return seed.threadId === query.threadId && seed.intentId === query.intentId && seed.requestHash === query.requestHash && seed.scope.workspaceId === query.workspaceId && sameResource(seed.scope.resource, query.resource);
}

function customFieldText(issue: BacklogIssue, id: number): string | null {
  const value = issue.customFields.find((field) => field.id === id)?.value;
  return typeof value === "string" ? value : null;
}

function resourceProjection(config: Pick<BacklogConnectorConfiguration, "application" | "environment">, resource: { kind: string; key: string }): string {
  return calculateFeedbackCommandHash({ application: config.application, environment: config.environment, resource });
}

function providerRef(issue: BacklogIssue) { return { providerKey: "backlog", objectId: String(issue.id), eventId: issue.issueKey }; }
function bindingContext(scope: Pick<FeedbackRepositoryScope, "profileId" | "installationId">, issueId: number) { return { profileId: scope.profileId, installationId: scope.installationId, objectId: String(issueId) }; }

function block(name: string, value: unknown): string { return `[${name}]\n${JSON.stringify(value)}\n[/${name}]`; }
function carrier(body: string, name: string, value: unknown): string { return `${body}\n\n${block(name, value)}`; }
function parseBlock(content: string, name: string): unknown | null {
  const startToken = `[${name}]\n`;
  const endToken = `\n[/${name}]`;
  const start = content.indexOf(startToken);
  if (start < 0) return null;
  const valueStart = start + startToken.length;
  const end = content.indexOf(endToken, valueStart);
  if (end < 0 || content.indexOf(startToken, valueStart) >= 0 || content.indexOf(endToken, end + endToken.length) >= 0) throw integrity(`Backlog ${name} carrierが曖昧です`);
  try { return JSON.parse(content.slice(valueStart, end)); } catch { throw integrity(`Backlog ${name} JSONが不正です`); }
}

function visibleBody(content: string): string {
  const positions = Object.values(backlogMarkerNames).map((name) => content.indexOf(`\n\n[${name}]\n`)).filter((value) => value >= 0);
  return positions.length === 0 ? content : content.slice(0, Math.min(...positions));
}

function assertMetadataSize(content: string, maximumBytes: number): void {
  if (new TextEncoder().encode(content).byteLength > maximumBytes) throw invalid("Backlog metadata carrierが上限を超えました");
}

function assertCommentBodyHash(comment: BacklogComment, marker: unknown): void {
  if (!isRecord(marker) || marker.bodyHash !== calculateFeedbackCommandHash({ body: visibleBody(comment.content) })) throw integrity("Backlog comment本文hashが一致しません");
}

function orderRevisionChain(messageId: string, events: readonly RevisionEvent[]): RevisionEvent[] {
  const byExpected = new Map<string, RevisionEvent[]>();
  const ids = new Set<string>();
  for (const event of events) {
    const expected = event.marker.expectedRevisionId;
    if (!expected || ids.has(event.marker.eventId) || event.marker.eventId === messageId) throw integrity("Backlog revision markerが重複または不正です");
    ids.add(event.marker.eventId);
    const values = byExpected.get(expected) ?? [];
    values.push(event);
    byExpected.set(expected, values);
  }
  const ordered: RevisionEvent[] = [];
  let expected = messageId;
  const visited = new Set([messageId]);
  for (;;) {
    const candidates = byExpected.get(expected) ?? [];
    if (candidates.length === 0) break;
    if (candidates.length !== 1 || visited.has(candidates[0]!.marker.eventId)) throw integrity("Backlog revision chainが分岐または循環しています");
    ordered.push(candidates[0]!);
    expected = candidates[0]!.marker.eventId;
    visited.add(expected);
  }
  if (ordered.length !== events.length) throw integrity("Backlog revision chainが連続していません");
  return ordered;
}

function messageFromComment(comment: BacklogComment, marker: Record<string, unknown>, currentParticipantId: string): FeedbackMessage {
  return {
    messageId: String(marker.messageId),
    body: visibleBody(comment.content),
    author: { kind: "participant", participantId: String(marker.participantId), displayName: "Participant", isCurrentParticipant: marker.participantId === currentParticipantId },
    createdAt: comment.created,
    orderingKey: { occurredAt: comment.created, eventId: String(marker.eventId) },
    revisions: [],
    attachments: []
  };
}

function messageFromRevision(comment: BacklogComment, marker: Record<string, unknown>, currentParticipantId: string): FeedbackMessage {
  const message = messageFromComment(comment, marker, currentParticipantId);
  message.revisions = [{ revisionId: String(marker.eventId), body: message.body, revisedAt: comment.created, orderingKey: message.orderingKey }];
  return message;
}

function providerMessage(comment: BacklogComment, messageId: string): FeedbackMessage {
  const displayName = comment.createdUser?.name ?? "Unknown";
  return { messageId, body: visibleBody(comment.content), author: displayName === "Unknown" ? { kind: "unknown", displayName } : { kind: "provider-user", displayName }, createdAt: comment.created, orderingKey: { occurredAt: comment.created, eventId: messageId }, revisions: [], attachments: [] };
}

function envelopeParticipant(envelope: Record<string, unknown>, currentParticipantId: string): FeedbackMessage["author"] {
  if (isRecord(envelope.createdBy) && typeof envelope.createdBy.participantId === "string") return { kind: "participant", participantId: envelope.createdBy.participantId, displayName: "Participant", isCurrentParticipant: envelope.createdBy.participantId === currentParticipantId };
  return { kind: "unknown", displayName: "Unknown" };
}

function storedResource(envelope: Record<string, unknown>): { kind: string; key: string } {
  if (isRecord(envelope.scope) && isResource(envelope.scope.resource)) return envelope.scope.resource;
  throw integrity("Backlog Envelope resourceが不正です");
}

function stableId(kind: string, providerId: string | number): string {
  const chars = calculateFeedbackCommandHash({ provider: "backlog", kind, providerId }).slice(7, 39).split("");
  chars[12] = "5";
  chars[16] = ["8", "9", "a", "b"][Number.parseInt(chars[16]!, 16) & 3]!;
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function issueClosed(name: string): boolean { return /^(?:closed|resolved|完了|処理済み)$/iu.test(name); }
function compareOrdering(left: { occurredAt: string; eventId: string }, right: { occurredAt: string; eventId: string }): number { return left.occurredAt.localeCompare(right.occurredAt) || left.eventId.localeCompare(right.eventId); }
function sameResource(left: { kind: string; key: string }, right: { kind: string; key: string }): boolean { return left.kind === right.kind && left.key === right.key; }
function sameMarkerIdentity(left: Record<string, unknown>, right: unknown): boolean { return isRecord(right) && left.intentId === right.intentId && left.requestHash === right.requestHash && left.eventId === right.eventId; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isResource(value: unknown): value is { kind: string; key: string } { return isRecord(value) && typeof value.kind === "string" && typeof value.key === "string"; }
function isRecoverySeed(value: unknown): value is RecoverySeed { return isRecord(value) && value.schemaVersion === "2" && value.state === "recovery-seed" && typeof value.threadId === "string" && uuid.test(value.threadId) && typeof value.intentId === "string" && uuid.test(value.intentId) && typeof value.requestHash === "string" && hash.test(value.requestHash) && isRecord(value.scope) && typeof value.scope.workspaceId === "string" && isResource(value.scope.resource); }

type RecoveryQuery<TOperation extends FeedbackRecoverableOperation> = FeedbackRepositoryScope & { threadId: string; intentId: string; requestHash: string; operation: TOperation };
function recoveryQuery<TOperation extends FeedbackRecoverableOperation>(query: FeedbackRepositoryScope & { threadId?: string; command: { threadId?: string; intentId: string; requestHash: string } }, operation: TOperation): RecoveryQuery<TOperation> {
  const threadId = query.threadId ?? query.command.threadId;
  if (!threadId) throw invalid("recovery threadIdがありません");
  return { profileId: query.profileId, installationId: query.installationId, workspaceId: query.workspaceId, resource: query.resource, threadId, intentId: query.command.intentId, requestHash: query.command.requestHash, operation };
}
function completed<TOperation extends FeedbackRecoverableOperation>(intentId: string, operation: TOperation, stableResultId: string): FeedbackIntentRecoveryResultFor<TOperation> { return { intentId, state: "completed", operation, stableResultId } as FeedbackIntentRecoveryResultFor<TOperation>; }
function pending<TOperation extends FeedbackRecoverableOperation>(intentId: string, operation: TOperation, retryAfterSeconds: number): FeedbackIntentRecoveryResultFor<TOperation> { return { intentId, state: "pending", operation, retryAfterSeconds, automaticWriteAllowed: false } as FeedbackIntentRecoveryResultFor<TOperation>; }
function repair<TOperation extends FeedbackRecoverableOperation>(intentId: string, operation: TOperation, detail: string, retryDirective: "recover-only" | "manual-confirmation" | "do-not-write"): FeedbackIntentRecoveryResultFor<TOperation> { return { intentId, state: "repair_required", operation, detail, automaticWriteAllowed: false, retryDirective } as FeedbackIntentRecoveryResultFor<TOperation>; }
function cursor(offset: number, fingerprint: string): string { return Buffer.from(JSON.stringify({ offset, fingerprint }), "utf8").toString("base64url"); }
function readCursor(value: string | undefined, fingerprint: string): number { if (!value) return 0; try { const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); if (isRecord(parsed) && parsed.fingerprint === fingerprint && Number.isInteger(parsed.offset) && Number(parsed.offset) >= 0) return Number(parsed.offset); } catch { /* 不正cursorは下で拒否する。 */ } throw invalid("Backlog cursorが不正です"); }
function unknownWriteResult(error: unknown): boolean { return error instanceof BacklogConnectorProblem && error.resultUnknown; }
function recoverableMetadataFailure(error: unknown): boolean { return error instanceof BacklogConnectorProblem && (error.resultUnknown || error.status >= 500 || error.status === 429); }
function invalid(message: string): BacklogConnectorProblem { return new BacklogConnectorProblem({ message, status: 400, code: "feedback.invalid_request", retryable: false }); }
function integrity(message: string): BacklogConnectorProblem { return new BacklogConnectorProblem({ message, status: 502, code: "feedback.integrity_error", retryable: false }); }
function unsupported(message: string): BacklogConnectorProblem { return new BacklogConnectorProblem({ message, status: 501, code: "feedback.unsupported", retryable: false }); }
function assertUuid(value: string, name: string): void { if (!uuid.test(value)) throw invalid(`${name}がUUIDではありません`); }
function assertHash(value: string): void { if (!hash.test(value)) throw invalid("requestHashが不正です"); }

function validateConfiguration(config: BacklogConnectorConfiguration): void {
  if (![config.profileId, config.installationId, config.application, config.environment, config.workspaceId, config.workspaceDisplayName].every((value) => typeof value === "string" && value.length > 0)) throw new Error("Backlog Connector設定が不足しています");
  assertUuid(config.participantId, "participantId");
  for (const [name, value] of Object.entries({ projectId: config.projectId, issueTypeId: config.issueTypeId, priorityId: config.priorityId, ...config.customFieldIds })) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Backlog ${name}が不正です`);
  if (new Set(Object.values(config.customFieldIds)).size !== 4) throw new Error("Backlog customFieldIdsが重複しています");
  if (!Number.isInteger(config.maximumMetadataBytes) || config.maximumMetadataBytes < 1024) throw new Error("Backlog maximumMetadataBytesが不正です");
  if (config.pageSize !== undefined && (!Number.isInteger(config.pageSize) || config.pageSize < 1 || config.pageSize > 100)) throw new Error("Backlog pageSizeが不正です");
  if (config.recoveryRetryAfterSeconds !== undefined && (!Number.isInteger(config.recoveryRetryAfterSeconds) || config.recoveryRetryAfterSeconds < 1 || config.recoveryRetryAfterSeconds > 300)) throw new Error("Backlog recoveryRetryAfterSecondsが不正です");
}
