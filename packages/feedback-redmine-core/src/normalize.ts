import type {
  RedmineAttachmentV1,
  RedmineThreadSummaryV1,
  RedmineThreadV1
} from "@feedback/contracts";
import { parseFeedbackTarget } from "@feedback/core";
import { contractError } from "./errors.js";
import {
  initialCommentFromDescription,
  parseFeedbackMetadata,
  parseRedmineMessageNote
} from "./marker.js";
import type { RedmineConnectorProfile } from "./profile.js";
import type { RedmineIssueDto } from "./redmine-dto.js";

type NamedValue = { id: number; name: string };
type TimelineItem = RedmineThreadV1["timeline"][number];
type ConversationMessage = NonNullable<RedmineThreadV1["messages"]>[number];

export function normalizeIssueSummary(
  input: unknown,
  profile: RedmineConnectorProfile
): RedmineThreadSummaryV1 {
  const issue = record(input, "issue") as RedmineIssueDto;
  const id = positiveInteger(issue.id, "issue.id");
  const subject = string(issue.subject, "issue.subject", 255);
  const description = string(issue.description, "issue.description", 65_535, true);
  const status = named(issue.status, "issue.status");
  const author = named(issue.author, "issue.author");
  const priority = issue.priority === undefined || issue.priority === null ? null : named(issue.priority, "issue.priority");
  const assignee = issue.assigned_to === undefined || issue.assigned_to === null
    ? null
    : named(issue.assigned_to, "issue.assigned_to");
  const createdAt = dateTime(issue.created_on, "issue.created_on");
  const updatedAt = dateTime(issue.updated_on, "issue.updated_on");
  const fields = customFieldMap(issue.custom_fields);
  const threadId = field(fields, profile.customFieldIds.threadId, "threadId");
  if (!uuidPattern.test(threadId)) throw contractError("threadId custom fieldがUUIDではありません");
  const perspectiveCode = optionalField(fields, profile.customFieldIds.perspectiveCode);
  const locator = parseLocator(optionalField(fields, profile.customFieldIds.locator));
  const attachments = issue.attachments === undefined ? [] : array(issue.attachments, "issue.attachments");
  return {
    threadId,
    issueId: id,
    subject,
    initialComment: initialCommentFromDescription(description),
    latestReply: null,
    status,
    priority,
    assignee,
    author,
    perspectiveCode,
    locator,
    hasAttachments: attachments.length > 0,
    createdAt,
    updatedAt,
    closed: (profile.closedStatusIds ?? []).includes(status.id)
  };
}

export function normalizeIssueDetail(
  input: unknown,
  profile: RedmineConnectorProfile,
  redmineUrl: string | null,
  currentParticipantId: string | null = null
): RedmineThreadV1 {
  const issue = record(input, "issue") as RedmineIssueDto;
  const summary = normalizeIssueSummary(issue, profile);
  const tracker = named(issue.tracker, "issue.tracker");
  const attachments = (issue.attachments === undefined ? [] : array(issue.attachments, "issue.attachments"))
    .map((attachment) => {
      const normalized = normalizeAttachment(attachment, profile.clientProfile.attachments.maximumInlinePreviewBytes);
      return {
        ...normalized,
        primaryEvidence: normalized.filename === `feedback-${summary.threadId}.png` ||
          normalized.filename === `feedback-${summary.threadId}.webp`
      };
    });
  const timeline: TimelineItem[] = [];
  const description = string(issue.description, "issue.description", 65_535, true);
  const initialMetadata = parseFeedbackMetadata(description);
  const fields = customFieldMap(issue.custom_fields);
  const contextAttached = attachments.some((attachment) => {
    try {
      return string(record(attachment, "attachment").filename, "attachment.filename", 255) === "feedback-context-v1.json";
    } catch {
      return false;
    }
  });
  const submittedById = optionalField(fields, profile.customFieldIds.submittedById);
  const submittedByName = optionalField(fields, profile.customFieldIds.submittedByName);
  const initialParticipantId = validUuid(initialMetadata?.participantId)
    ? initialMetadata!.participantId!
    : contextAttached && validUuid(submittedById ?? undefined) ? submittedById! : null;
  const initialMessageId = validUuid(initialMetadata?.messageId) ? initialMetadata!.messageId! : summary.threadId;
  const initialDisplayName = initialMetadata?.submittedByName?.trim() || submittedByName?.trim() || summary.author.name;
  const messages: ConversationMessage[] = [{
    id: initialMessageId,
    kind: "initial",
    journalId: null,
    body: summary.initialComment,
    author: {
      kind: initialParticipantId ? "participant" : "redmine",
      participantId: initialParticipantId,
      displayName: initialDisplayName
    },
    createdAt: summary.createdAt,
    editedAt: null,
    version: 1,
    versions: [{ version: 1, body: summary.initialComment, editedAt: summary.createdAt }],
    canEdit: initialParticipantId !== null && initialParticipantId === currentParticipantId
  }];
  let diagnosticCount = 0;
  const journals = issue.journals === undefined ? [] : array(issue.journals, "issue.journals");
  for (const rawJournal of journals) {
    try {
      const normalized = normalizeJournal(rawJournal, currentParticipantId);
      timeline.push(...normalized.timeline);
      if (normalized.edit) {
        const message = messages.find((candidate) => candidate.id === normalized.edit!.messageId);
        if (message && normalized.edit.version === message.version + 1) {
          message.body = normalized.edit.body;
          message.version = normalized.edit.version;
          message.editedAt = normalized.edit.editedAt;
          message.versions.push({
            version: normalized.edit.version,
            body: normalized.edit.body,
            editedAt: normalized.edit.editedAt
          });
          const reply = timeline.find((candidate) => candidate.kind === "reply" && candidate.messageId === message.id);
          if (reply?.kind === "reply") {
            reply.body = normalized.edit.body;
            reply.updatedAt = normalized.edit.editedAt;
            reply.version = normalized.edit.version;
            reply.versions = message.versions;
          }
        }
      } else if (normalized.message) messages.push(normalized.message);
    } catch {
      diagnosticCount += 1;
      const journal = rawJournal && typeof rawJournal === "object" ? rawJournal as Record<string, unknown> : {};
      timeline.push({
        kind: "diagnostic",
        journalId: Number.isInteger(journal.id) && (journal.id as number) > 0 ? journal.id as number : null,
        message: "Redmine journalの形式が不正なため内容を表示できません"
      });
    }
  }
  timeline.sort((left, right) => (left.journalId ?? Number.MAX_SAFE_INTEGER) - (right.journalId ?? Number.MAX_SAFE_INTEGER));
  if (messages[0]?.editedAt === null) {
    const descriptionUpdate = [...timeline].reverse().find((item) => item.kind === "activity" && item.field === "description");
    if (descriptionUpdate?.kind === "activity") messages[0].editedAt = descriptionUpdate.createdAt;
  }
  const latestReply = [...timeline].reverse().find((item) => item.kind === "reply");
  return {
    ...summary,
    latestReply: latestReply?.kind === "reply" ? latestReply.body : null,
    description,
    tracker,
    timeline,
    attachments,
    redmineUrl,
    diagnosticCount,
    messages
  };
}

export function customFieldValue(input: unknown, id: number): string | null {
  return optionalField(customFieldMap(input), id);
}

function normalizeJournal(input: unknown, currentParticipantId: string | null): {
  timeline: TimelineItem[];
  message: ConversationMessage | null;
  edit: { messageId: string; body: string; version: number; editedAt: string } | null;
} {
  const journal = record(input, "journal");
  const id = positiveInteger(journal.id, "journal.id");
  const author = named(journal.user, "journal.user");
  const createdAt = dateTime(journal.created_on, "journal.created_on");
  const updatedAt = journal.updated_on === undefined || journal.updated_on === null
    ? null
    : dateTime(journal.updated_on, "journal.updated_on");
  const result: TimelineItem[] = [];
  let message: ConversationMessage | null = null;
  let edit: { messageId: string; body: string; version: number; editedAt: string } | null = null;
  if (typeof journal.notes !== "string") throw contractError("journal.notesがstringではありません");
  if (journal.notes.trim()) {
    const marked = parseRedmineMessageNote(journal.notes);
    if (marked?.metadata.kind === "edit") {
      edit = {
        messageId: marked.metadata.messageId,
        body: marked.body,
        version: marked.metadata.version,
        editedAt: updatedAt ?? createdAt
      };
    } else {
      const messageId = marked?.metadata.messageId ?? journalMessageId(id);
      const participantId = marked?.metadata.participantId ?? null;
      const body = marked?.body ?? journal.notes;
      const displayName = marked?.metadata.participantName?.trim() || author.name;
      result.push({
        kind: "reply",
        journalId: id,
        body,
        author,
        createdAt,
        updatedAt,
        messageId,
        participantId,
        displayName,
        version: 1,
        canEdit: participantId !== null && participantId === currentParticipantId,
        versions: [{ version: 1, body, editedAt: createdAt }]
      });
      message = {
        id: messageId,
        kind: "reply",
        journalId: id,
        body,
        author: {
          kind: participantId ? "participant" : "redmine",
          participantId,
          displayName
        },
        createdAt,
        editedAt: updatedAt,
        version: 1,
        versions: [{ version: 1, body, editedAt: createdAt }],
        canEdit: participantId !== null && participantId === currentParticipantId
      };
    }
  }
  for (const inputDetail of journal.details === undefined ? [] : array(journal.details, "journal.details")) {
    const detail = record(inputDetail, "journal detail");
    const field = activityField(detail);
    if (!field) continue;
    result.push({
      kind: "activity",
      journalId: id,
      field,
      oldValue: nullableScalar(detail.old_value),
      newValue: nullableScalar(detail.new_value),
      author,
      createdAt
    });
  }
  return { timeline: result, message, edit };
}

function journalMessageId(journalId: number): string {
  return `00000000-0000-4000-8000-${journalId.toString(16).padStart(12, "0").slice(-12)}`;
}

function validUuid(value: string | undefined): boolean {
  return typeof value === "string" && uuidPattern.test(value);
}

function activityField(detail: Record<string, unknown>): Extract<TimelineItem, { kind: "activity" }>["field"] | null {
  const name = typeof detail.name === "string" ? detail.name : "";
  const mapping: Record<string, Extract<TimelineItem, { kind: "activity" }>["field"]> = {
    status_id: "status",
    assigned_to_id: "assignee",
    priority_id: "priority",
    tracker_id: "tracker",
    subject: "subject",
    description: "description",
    attachment: "attachment"
  };
  if (detail.property === "attachment") return "attachment";
  return mapping[name] ?? null;
}

function normalizeAttachment(input: unknown, maximumInlinePreviewBytes: number): RedmineAttachmentV1 {
  const attachment = record(input, "attachment");
  const contentType = attachment.content_type === undefined || attachment.content_type === null
    ? null
    : string(attachment.content_type, "attachment.content_type", 255);
  const byteSize = nonnegativeInteger(attachment.filesize, "attachment.filesize");
  return {
    id: positiveInteger(attachment.id, "attachment.id"),
    filename: sanitizeFilename(string(attachment.filename, "attachment.filename", 255)),
    byteSize,
    contentType,
    author: named(attachment.author, "attachment.author"),
    createdAt: dateTime(attachment.created_on, "attachment.created_on"),
    inlinePreview: (contentType === "image/png" || contentType === "image/webp") && byteSize <= maximumInlinePreviewBytes,
    primaryEvidence: false
  };
}

export function sanitizeFilename(value: string): string {
  const segments = value.split(/[\\/]/u);
  const leaf = segments[segments.length - 1] ?? value;
  const sanitized = leaf
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/gu, "_")
    .replace(/^\.+/u, "")
    .trim();
  return Array.from(sanitized || "attachment").slice(0, 200).join("");
}

function parseLocator(value: string | null): RedmineThreadSummaryV1["locator"] {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const location = record(parsed.location, "locator.location");
    const pathParameters = stringRecord(location.pathParameters);
    const queryParameters = location.queryParameters === undefined ? undefined : stringRecord(location.queryParameters);
    if (
      parsed.v !== "1" ||
      location.schemaVersion !== "1" ||
      typeof location.pageKey !== "string" ||
      typeof location.routeTemplate !== "string" ||
      !pathParameters ||
      (location.queryParameters !== undefined && !queryParameters)
    ) return null;
    const target = parsed.target === null ? null : parseFeedbackTarget(parsed.target);
    if (parsed.target !== null && !target) return null;
    return {
      v: "1",
      location: {
        schemaVersion: "1",
        pageKey: location.pageKey,
        routeTemplate: location.routeTemplate,
        pathParameters,
        ...(queryParameters ? { queryParameters } : {})
      },
      target
    };
  } catch {
    return null;
  }
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, entry]) => typeof entry !== "string")) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

function customFieldMap(input: unknown): Map<number, string> {
  const values = array(input, "issue.custom_fields");
  const result = new Map<number, string>();
  for (const item of values) {
    const customField = record(item, "custom field");
    const id = positiveInteger(customField.id, "custom field id");
    if (typeof customField.value === "string") result.set(id, customField.value);
    else if (customField.value === null) result.set(id, "");
    else throw contractError("custom field valueが単一stringではありません");
  }
  return result;
}

function field(fields: Map<number, string>, id: number, name: string): string {
  const value = fields.get(id);
  if (value === undefined || !value) throw contractError(`${name} custom fieldがありません`);
  return value;
}

function optionalField(fields: Map<number, string>, id: number): string | null {
  const value = fields.get(id);
  return value?.trim() ? value : null;
}

function named(value: unknown, name: string): NamedValue {
  const item = record(value, name);
  return { id: positiveInteger(item.id, `${name}.id`), name: string(item.name, `${name}.name`, 255) };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw contractError(`${name}がobjectではありません`);
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw contractError(`${name}がarrayではありません`);
  return value;
}

function string(value: unknown, name: string, maxLength: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value) || value.length > maxLength) {
    throw contractError(`${name}が不正なstringです`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw contractError(`${name}がpositive integerではありません`);
  return value as number;
}

function nonnegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw contractError(`${name}がnonnegative integerではありません`);
  return value as number;
}

function dateTime(value: unknown, name: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw contractError(`${name}がdate-timeではありません`);
  return value;
}

function nullableScalar(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
