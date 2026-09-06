import type {
  FeedbackAttachmentV2,
  FeedbackMessageV2,
  FeedbackResourceRefV2,
  FeedbackThreadV2
} from "@geibee/feedback-contracts/v2";
import type { FeedbackAttachmentMarkerV2, FeedbackEnvelopeV2, FeedbackProjectionV2 } from "@geibee/feedback-contracts/v2/server";
import {
  FeedbackConnectorProblem,
  type FeedbackProjectionCandidate,
  type FeedbackRepositoryCandidateRead,
  type FeedbackRepositoryScope
} from "@geibee/feedback-connector-sdk";
import { calculateFeedbackCommandHash, type FeedbackEnvelopeCodecPort } from "@geibee/feedback-envelope";
import { deriveRedmineStableId, initialBodyFromDescription, parseLegacyDescription, validStableId } from "./legacy.js";
import { parseRedmineMessageNote } from "./markers.js";
import type { FeedbackRedmineProfileV2, RedmineIssueRaw, RedmineIssueSummaryRaw } from "./redmine-types.js";

export type RedmineMappedIssue = FeedbackRepositoryCandidateRead & {
  envelope: FeedbackEnvelopeV2 | null;
  warnings: string[];
};

export function redmineProjectionCandidate(
  issue: RedmineIssueSummaryRaw,
  profile: FeedbackRedmineProfileV2,
  fallbackResource: FeedbackResourceRefV2
): FeedbackProjectionCandidate | null {
  const fields = customFields(issue.custom_fields);
  const rawProjection = jsonField(fields.get(profile.customFieldIds.projection));
  const projection = rawProjection === null
    ? legacyProjection(issue, fields, profile, fallbackResource)
    : parseProjection(rawProjection) ?? integrity("Redmine projection custom fieldが不正です");
  if (!projection) return null;
  return {
    providerRef: { providerKey: "redmine", objectId: String(issue.id) },
    projection
  };
}

export async function mapRedmineIssue(
  issue: RedmineIssueRaw,
  profile: FeedbackRedmineProfileV2,
  scope: FeedbackRepositoryScope,
  codec: FeedbackEnvelopeCodecPort
): Promise<RedmineMappedIssue> {
  assertIssueId(issue.id);
  const objectId = String(issue.id);
  const fields = customFields(issue.custom_fields);
  const envelopeValue = jsonField(fields.get(profile.customFieldIds.envelope));
  let envelope: FeedbackEnvelopeV2 | null = null;
  const warnings: string[] = [];
  if (envelopeValue !== null) {
    const verified = await codec.verifyEnvelope(envelopeValue, {
      profileId: profile.profileId,
      installationId: profile.installationId,
      objectId
    });
    if (!verified.valid) integrity(`Redmine Envelopeを検証できません: ${verified.reason}`);
    envelope = verified.value;
    assertEnvelopeScope(envelope, scope, profile);
  }

  const legacy = legacyMetadata(issue, fields, profile);
  if (!envelope && !legacy.threadId) integrity("Redmine issueにthread IDがありません");
  if (envelope && legacy.threadId && legacy.threadId !== envelope.threadId) {
    warnings.push("legacy threadIdと署名済みEnvelopeが異なるためEnvelopeを優先しました");
  }
  const threadId = envelope?.threadId ?? legacy.threadId!;
  if (!validStableId(threadId)) integrity("Redmine thread IDがstable IDではありません");
  if (!envelope) assertLegacyScope(legacy, scope, profile);

  const providerBinding = { profileId: profile.profileId, installationId: profile.installationId, objectId };
  const createdAt = dateTime(issue.created_on, "issue.created_on");
  const updatedAt = dateTime(issue.updated_on ?? issue.created_on, "issue.updated_on");
  const initialBody = initialBodyFromDescription(issue.description);
  if (envelope?.initialBodyHash && envelope.initialBodyHash !== calculateFeedbackCommandHash({ body: initialBody })) {
    integrity("Redmine initial本文が署名済みhashと一致しません");
  }
  const initialMessage: FeedbackMessageV2 = {
    messageId: threadId,
    body: initialBodyFromDescription(issue.description),
    author: envelope?.initialBodyHash
      ? participantAuthor(envelope.createdBy.participantId, profile)
      : providerAuthor(issue.author),
    createdAt,
    orderingKey: { occurredAt: createdAt, eventId: threadId },
    revisions: [{ revisionId: threadId, body: initialBodyFromDescription(issue.description), revisedAt: createdAt, orderingKey: { occurredAt: createdAt, eventId: threadId } }],
    attachments: []
  };
  const messages = new Map<string, FeedbackMessageV2>([[threadId, initialMessage]]);
  // Redmine v1 ticket互換は保持するが、未検証v1 eventをv2 messageの編集として適用しない。
  const v2MessageIds = new Set<string>(envelope ? [threadId] : []);
  const attachmentMappings = new Map<string, FeedbackAttachmentMarkerV2>();

  for (const journal of array(issue.journals)) {
    const item = record(journal);
    const journalId = positiveInteger(item.id, "journal.id");
    const occurredAt = dateTime(item.created_on, "journal.created_on");
    const marked = parseRedmineMessageNote(item.notes);
    if (!marked) {
      if (typeof item.notes === "string" && item.notes.trim()) {
        const messageId = deriveRedmineStableId("journal", issue.id, journalId);
        messages.set(messageId, messageFromLegacy(messageId, item.notes.trim(), occurredAt, providerAuthor(item.user)));
      }
      continue;
    }

    if (marked.metadata.feedbackV2Attachment !== undefined) {
      const result = await codec.verifyAttachmentMarker(marked.metadata.feedbackV2Attachment, providerBinding);
      if (!result.valid) integrity(`Redmine attachment markerを検証できません: ${result.reason}`);
      if (result.value.threadId !== threadId) integrity("Redmine attachment markerのthread bindingが異なります");
      attachmentMappings.set(result.value.providerAttachmentId, result.value);
      continue;
    }

    if (marked.metadata.feedbackV2 !== undefined) {
      const result = await codec.verifyMessageMarker(marked.metadata.feedbackV2, providerBinding);
      if (!result.valid) integrity(`Redmine message markerを検証できません: ${result.reason}`);
      const marker = result.value;
      if (marker.threadId !== threadId || marker.bodyHash !== calculateFeedbackCommandHash({ body: marked.body })) {
        integrity("Redmine message markerのthread/body bindingが異なります");
      }
      if (marked.metadata.messageId !== marker.messageId || marked.metadata.intentId !== marker.intentId ||
        marked.metadata.participantId !== marker.participantId ||
        marked.metadata.kind !== (marker.eventKind === "reply" ? "reply" : "edit")) {
        warnings.push(`journal ${journalId}のlegacy markerとv2 markerが異なるためv2を優先しました`);
      }
      if (marker.eventKind === "reply") {
        if (!messages.has(marker.messageId) || !v2MessageIds.has(marker.messageId)) {
          messages.set(marker.messageId, messageFromV2(marker.messageId, marker.eventId, marked.body, occurredAt,
            participantAuthor(marker.participantId, profile)));
        }
        v2MessageIds.add(marker.messageId);
      } else {
        const target = messages.get(marker.messageId);
        const owner = marker.messageId === threadId && envelope
          ? participantAuthor(envelope.createdBy.participantId, profile) : target?.author;
        if (owner?.kind !== "participant" || owner.participantId !== marker.participantId) {
          integrity("Redmine revision participantが元message authorと一致しません");
        }
        appendRevision(messages, marker.messageId, marker.eventId, marker.expectedRevisionId!, marked.body, occurredAt);
        target!.author = owner;
      }
      continue;
    }

    if (v2MessageIds.has(marked.metadata.messageId)) {
      warnings.push(`journal ${journalId}の未検証v1 markerはv2 messageへ適用しません`);
      continue;
    }
    mapLegacyMarkedJournal(messages, issue.id, journalId, occurredAt, marked, item.user);
  }

  const attachments = await mapAttachments(issue, attachmentMappings, threadId);
  initialMessage.attachments = attachments.filter((attachment) => !attachment.messageId).map(stripMessageId);
  for (const attachment of attachments) {
    if (!attachment.messageId) continue;
    const message = messages.get(attachment.messageId);
    if (message) message.attachments.push(stripMessageId(attachment));
  }

  const resource = envelope?.scope.resource ?? scope.resource;
  const sortedMessages = [...messages.values()].sort(compareMessages);
  const thread: FeedbackThreadV2 = {
    threadId,
    resource,
    title: string(issue.subject, "issue.subject"),
    status: isClosed(issue.status) ? "closed" : "open",
    createdAt,
    updatedAt,
    messageCount: sortedMessages.length,
    messages: sortedMessages
  };
  return {
    providerRef: { providerKey: "redmine", objectId },
    envelope,
    legacyMetadata: envelope ? legacy : { ...legacy, mapping: "redmine-v1" },
    thread,
    warnings
  };
}

type AttachmentWithMessage = FeedbackAttachmentV2 & { messageId?: string };

async function mapAttachments(
  issue: RedmineIssueRaw,
  mappings: ReadonlyMap<string, FeedbackAttachmentMarkerV2>,
  threadId: string
): Promise<AttachmentWithMessage[]> {
  return array(issue.attachments).map((raw) => {
    const item = record(raw);
    const providerId = String(item.id);
    const mapping = mappings.get(providerId);
    if (mapping && mapping.threadId !== threadId) integrity("Redmine attachment mappingのthread IDが異なります");
    if (mapping && (mapping.filename !== item.filename || mapping.sizeBytes !== item.filesize ||
      typeof item.content_type === "string" && item.content_type && mapping.contentType !== item.content_type)) {
      integrity("Redmine attachment mappingとprovider metadataが一致しません");
    }
    return {
      attachmentId: mapping?.attachmentId ?? deriveRedmineStableId("attachment", issue.id, providerId),
      filename: string(item.filename, "attachment.filename"),
      contentType: typeof item.content_type === "string" && item.content_type ? item.content_type : "application/octet-stream",
      sizeBytes: positiveInteger(item.filesize, "attachment.filesize", true),
      createdAt: dateTime(item.created_on, "attachment.created_on"),
      ...(mapping
        ? { messageId: mapping.messageId }
        : typeof item.description === "string" && validStableId(item.description) ? { messageId: item.description } : {})
    };
  });
}

function mapLegacyMarkedJournal(
  messages: Map<string, FeedbackMessageV2>,
  issueId: number,
  journalId: number,
  occurredAt: string,
  marked: NonNullable<ReturnType<typeof parseRedmineMessageNote>>,
  rawAuthor: unknown
): void {
  const messageId = validStableId(marked.metadata.messageId)
    ? marked.metadata.messageId
    : deriveRedmineStableId("legacy-message", issueId, marked.metadata.messageId || journalId);
  const participant = providerAuthor(rawAuthor);
  if (marked.metadata.kind === "reply") {
    if (!messages.has(messageId)) messages.set(messageId, messageFromLegacy(messageId, marked.body, occurredAt, participant));
    return;
  }
  const message = messages.get(messageId);
  if (!message) return;
  const revisionId = deriveRedmineStableId("legacy-revision", issueId, journalId);
  message.body = marked.body;
  message.revisions.push({ revisionId, body: marked.body, revisedAt: occurredAt, orderingKey: { occurredAt, eventId: revisionId } });
}

function appendRevision(
  messages: Map<string, FeedbackMessageV2>,
  messageId: string,
  revisionId: string,
  expectedRevisionId: string,
  body: string,
  occurredAt: string
): void {
  const message = messages.get(messageId);
  if (!message) integrity("Redmine revisionが未知のmessageを参照しています");
  const latest = message.revisions[message.revisions.length - 1];
  if (!latest || latest.revisionId !== expectedRevisionId) integrity("Redmine revision chainが不正です");
  message.body = body;
  message.revisions.push({ revisionId, body, revisedAt: occurredAt, orderingKey: { occurredAt, eventId: revisionId } });
}

function messageFromV2(
  messageId: string,
  revisionId: string,
  body: string,
  createdAt: string,
  author: FeedbackMessageV2["author"]
): FeedbackMessageV2 {
  return {
    messageId,
    body,
    author,
    createdAt,
    orderingKey: { occurredAt: createdAt, eventId: messageId },
    revisions: [{ revisionId, body, revisedAt: createdAt, orderingKey: { occurredAt: createdAt, eventId: revisionId } }],
    attachments: []
  };
}

function messageFromLegacy(messageId: string, body: string, createdAt: string, author: FeedbackMessageV2["author"]): FeedbackMessageV2 {
  return messageFromV2(messageId, messageId, body, createdAt, author);
}

function participantAuthor(participantId: string, profile: FeedbackRedmineProfileV2): FeedbackMessageV2["author"] {
  const current = participantId === profile.participantId;
  return { kind: "participant", participantId, displayName: current ? profile.participantDisplayName : "Feedback participant", isCurrentParticipant: current };
}

function providerAuthor(value: unknown): FeedbackMessageV2["author"] {
  const item = recordOrNull(value);
  const name = item && typeof item.name === "string" && item.name.trim() ? item.name.trim() : null;
  return name ? { kind: "provider-user", displayName: name } : { kind: "unknown", displayName: "Unknown" };
}

function legacyMetadata(issue: RedmineIssueRaw, fields: ReadonlyMap<number, unknown>, profile: FeedbackRedmineProfileV2) {
  const description = parseLegacyDescription(issue.description);
  return {
    threadId: fieldText(fields, profile.customFieldIds.threadId) ?? description.threadId ?? null,
    intentId: fieldText(fields, profile.customFieldIds.intentId) ?? description.intentId ?? null,
    requestHash: normalizedHash(fieldText(fields, profile.customFieldIds.requestHash) ?? description.requestHash ?? null),
    applicationKey: fieldText(fields, profile.customFieldIds.applicationKey) ?? description.applicationKey ?? null,
    environmentKey: fieldText(fields, profile.customFieldIds.environmentKey) ?? description.environmentKey ?? null,
    workspaceId: fieldText(fields, profile.customFieldIds.externalWorkspaceKey) ?? description.workspaceId ?? null,
    resourceKey: fieldText(fields, profile.customFieldIds.hostResourceKey) ?? description.resourceKey ?? null,
    participantId: description.participantId ?? null
  };
}

function legacyProjection(
  issue: RedmineIssueSummaryRaw,
  fields: ReadonlyMap<number, unknown>,
  profile: FeedbackRedmineProfileV2,
  resource: FeedbackResourceRefV2
): FeedbackProjectionV2 | null {
  const threadId = fieldText(fields, profile.customFieldIds.threadId);
  if (!threadId || !validStableId(threadId)) return null;
  return {
    schemaVersion: "2",
    threadId,
    intentId: fieldText(fields, profile.customFieldIds.intentId) ?? threadId,
    requestHash: normalizedHash(fieldText(fields, profile.customFieldIds.requestHash)) ?? calculateFeedbackCommandHash({ legacy: "redmine", issueId: issue.id }),
    profileId: profile.profileId,
    workspaceId: profile.workspaceId,
    resource
  };
}

function parseProjection(value: unknown): FeedbackProjectionV2 | null {
  if (!recordOrNull(value)) return null;
  const candidate = value as Partial<FeedbackProjectionV2>;
  const resource = recordOrNull(candidate.resource);
  if (candidate.schemaVersion !== "2" || !validStableId(candidate.threadId) || !validStableId(candidate.intentId) ||
    typeof candidate.requestHash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(candidate.requestHash) ||
    typeof candidate.profileId !== "string" || typeof candidate.workspaceId !== "string" ||
    !resource || typeof resource.kind !== "string" || typeof resource.key !== "string") return null;
  return candidate as FeedbackProjectionV2;
}

function assertEnvelopeScope(envelope: FeedbackEnvelopeV2, scope: FeedbackRepositoryScope, profile: FeedbackRedmineProfileV2): void {
  if (envelope.scope.workspace !== scope.workspaceId || envelope.scope.workspace !== profile.workspaceId ||
    envelope.scope.application !== profile.applicationKey || envelope.scope.environment !== profile.environmentKey ||
    envelope.scope.resource.kind !== scope.resource.kind || envelope.scope.resource.key !== scope.resource.key) {
    integrity("Redmine Envelopeのscopeがrequestと一致しません");
  }
}

function assertLegacyScope(
  legacy: ReturnType<typeof legacyMetadata>,
  scope: FeedbackRepositoryScope,
  profile: FeedbackRedmineProfileV2
): void {
  if (legacy.applicationKey !== profile.applicationKey || legacy.environmentKey !== profile.environmentKey ||
    legacy.workspaceId !== scope.workspaceId || legacy.resourceKey !== scope.resource.key) {
    integrity("Redmine legacy metadataのscopeがrequestと一致しません");
  }
}

function customFields(value: unknown): Map<number, unknown> {
  const result = new Map<number, unknown>();
  for (const raw of array(value)) {
    const field = record(raw);
    if (Number.isInteger(field.id) && Number(field.id) > 0) result.set(Number(field.id), field.value);
  }
  return result;
}

function fieldText(fields: ReadonlyMap<number, unknown>, id: number): string | null {
  const value = fields.get(id);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function jsonField(value: unknown): unknown | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return Symbol.for("feedback.redmine.invalid-json"); }
}

function normalizedHash(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.startsWith("sha256:") ? value : `sha256:${value}`;
  return /^sha256:[a-f0-9]{64}$/u.test(normalized) ? normalized : null;
}

function dateTime(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) integrity(`${field}がdate-timeではありません`);
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") integrity(`${field}がstringではありません`);
  return value;
}

function positiveInteger(value: unknown, field: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) integrity(`${field}が正の整数ではありません`);
  return Number(value);
}

function array(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : integrity("Redmine provider arrayが不正です");
}

function record(value: unknown): Record<string, unknown> {
  return recordOrNull(value) ?? integrity("Redmine provider objectが不正です");
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isClosed(value: unknown): boolean {
  const status = recordOrNull(value);
  return status?.is_closed === true;
}

function stripMessageId(value: AttachmentWithMessage): FeedbackAttachmentV2 {
  const { messageId: _messageId, ...attachment } = value;
  return attachment;
}

function compareMessages(left: FeedbackMessageV2, right: FeedbackMessageV2): number {
  return left.orderingKey.occurredAt.localeCompare(right.orderingKey.occurredAt) || left.orderingKey.eventId.localeCompare(right.orderingKey.eventId);
}

function assertIssueId(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) integrity("Redmine issue IDが不正です");
}

function integrity(message: string): never {
  throw new FeedbackConnectorProblem({
    code: "feedback.integrity_error",
    status: 502,
    retryable: false,
    message
  });
}
