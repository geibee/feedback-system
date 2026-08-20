import type {
  FeedbackTargetV1,
  RedmineCurrentPrincipalV1,
  RedmineThreadSummaryV1,
  RedmineThreadV1
} from "@feedback/contracts";
import type { RedmineProfileResult } from "./port.js";
import type { RedmineThreadListResult } from "./model.js";
import { validateClientProfile } from "./profile.js";

export function parseProfileResult(value: unknown): RedmineProfileResult {
  const result = exact(value, ["profile", "capabilities"], "profile result");
  const capabilities = exact(result.capabilities, ["canRead", "canCreate", "canReply", "canEditOwn", "stateReadOnly"], "capabilities");
  if (typeof capabilities.canRead !== "boolean" || typeof capabilities.canCreate !== "boolean" ||
    typeof capabilities.canReply !== "boolean" || typeof capabilities.canEditOwn !== "boolean" ||
    capabilities.stateReadOnly !== true) throw invalid("capabilities");
  return { profile: validateClientProfile(result.profile), capabilities: capabilities as RedmineProfileResult["capabilities"] };
}

export function parseCurrentUserResult(value: unknown): RedmineCurrentPrincipalV1 {
  const result = exact(value, ["principal"], "current user result");
  const principal = exact(result.principal, ["participantId", "displayName", "source"], "principal");
  if (!uuidPattern.test(String(principal.participantId))) throw invalid("participantId");
  if (principal.displayName !== null) text(principal.displayName, "displayName", 200);
  if (principal.source !== "participant-credential") throw invalid("principal source");
  return principal as RedmineCurrentPrincipalV1;
}

export function parseThreadListResult(value: unknown): RedmineThreadListResult {
  const result = exact(value, ["threads", "nextCursor"], "thread list result");
  if (!Array.isArray(result.threads) || result.threads.length > 50 ||
    (result.nextCursor !== null && (typeof result.nextCursor !== "string" || result.nextCursor.length > 2048))) {
    throw invalid("thread list");
  }
  return { threads: result.threads.map(parseThreadSummary), nextCursor: result.nextCursor };
}

export function parseThreadResult(value: unknown): RedmineThreadV1 {
  const result = exact(value, ["thread"], "thread result");
  const thread = exact(result.thread, [...summaryKeys, ...detailKeys], "thread", ["messages", "closed"]);
  validateSummary(thread);
  text(thread.description, "description", 65_535, true);
  named(thread.tracker, "tracker");
  if (!Array.isArray(thread.timeline) || !Array.isArray(thread.attachments)) throw invalid("timeline/attachments");
  thread.timeline.forEach(timeline);
  if (thread.messages !== undefined) {
    if (!Array.isArray(thread.messages)) throw invalid("messages");
    thread.messages.forEach(conversationMessage);
  }
  thread.attachments.forEach(attachment);
  if (thread.redmineUrl !== null) {
    text(thread.redmineUrl, "redmineUrl", 2_048);
    try { new URL(thread.redmineUrl as string); } catch { throw invalid("redmineUrl"); }
  }
  integer(thread.diagnosticCount, "diagnosticCount", 0);
  return thread as unknown as RedmineThreadV1;
}

export function parseThreadSummary(value: unknown): RedmineThreadSummaryV1 {
  const thread = exact(value, summaryKeys, "thread summary", ["closed"]);
  validateSummary(thread);
  return thread as unknown as RedmineThreadSummaryV1;
}

const summaryKeys = [
  "threadId", "issueId", "subject", "initialComment", "latestReply", "status", "priority", "assignee", "author",
  "perspectiveCode", "locator", "hasAttachments", "createdAt", "updatedAt", "closed"
] as const;
const detailKeys = ["description", "tracker", "timeline", "attachments", "redmineUrl", "diagnosticCount", "messages"] as const;

function validateSummary(thread: Record<string, unknown>): void {
  if (!uuidPattern.test(String(thread.threadId))) throw invalid("threadId");
  integer(thread.issueId, "issueId", 1);
  text(thread.subject, "subject", 255, true);
  text(thread.initialComment, "initialComment", 65_535, true);
  if (thread.latestReply !== null) text(thread.latestReply, "latestReply", 65_535, true);
  named(thread.status, "status");
  if (thread.priority !== null) named(thread.priority, "priority");
  if (thread.assignee !== null) named(thread.assignee, "assignee");
  named(thread.author, "author");
  if (thread.perspectiveCode !== null) text(thread.perspectiveCode, "perspectiveCode", 100);
  if (thread.locator !== null) locator(thread.locator);
  if (typeof thread.hasAttachments !== "boolean") throw invalid("hasAttachments");
  dateTime(thread.createdAt, "createdAt");
  dateTime(thread.updatedAt, "updatedAt");
  if (thread.closed !== undefined && typeof thread.closed !== "boolean") throw invalid("closed");
}

function locator(value: unknown): void {
  const item = exact(value, ["v", "location", "target"], "locator");
  if (item.v !== "1") throw invalid("locator version");
  const location = exact(item.location, ["schemaVersion", "pageKey", "routeTemplate", "pathParameters", "queryParameters"], "location", ["queryParameters"]);
  if (location.schemaVersion !== "1") throw invalid("location version");
  text(location.pageKey, "pageKey", 100);
  text(location.routeTemplate, "routeTemplate", 500);
  stringMap(location.pathParameters, "pathParameters");
  if (location.queryParameters !== undefined) stringMap(location.queryParameters, "queryParameters");
  if (item.target !== null) target(item.target);
}

function target(value: unknown): FeedbackTargetV1 {
  const item = object(value, "target");
  if (item.kind === "ui-element") {
    exact(item, ["schemaVersion", "kind", "elementKey", "relativeX", "relativeY"], "ui target");
    if (item.schemaVersion !== "1") throw invalid("target version");
    text(item.elementKey, "elementKey", 200);
    relative(item.relativeX); relative(item.relativeY);
  } else if (item.kind === "screen-position") {
    exact(item, ["schemaVersion", "kind", "relativeX", "relativeY"], "screen target");
    if (item.schemaVersion !== "1") throw invalid("target version");
    relative(item.relativeX); relative(item.relativeY);
  } else if (item.kind === "map-position") {
    exact(item, ["schemaVersion", "kind", "longitude", "latitude"], "map target");
    if (item.schemaVersion !== "1") throw invalid("target version");
    number(item.longitude, -180, 180); number(item.latitude, -90, 90);
  } else if (item.kind === "map-feature") {
    exact(item, ["schemaVersion", "kind", "provider", "sourceKey", "sourceLayer", "featureKey", "longitude", "latitude"], "map feature target", ["sourceLayer"]);
    if (item.schemaVersion !== "1" || item.provider !== "maplibre") throw invalid("map feature target");
    text(item.sourceKey, "sourceKey", 200); text(item.featureKey, "featureKey", 200);
    if (item.sourceLayer !== undefined) text(item.sourceLayer, "sourceLayer", 200);
    number(item.longitude, -180, 180); number(item.latitude, -90, 90);
  } else throw invalid("target kind");
  return item as unknown as FeedbackTargetV1;
}

function timeline(value: unknown): void {
  const item = object(value, "timeline item");
  if (item.kind === "reply") {
    const optional = ["messageId", "participantId", "displayName", "version", "canEdit", "versions"] as const;
    const reply = exact(item, ["kind", "journalId", "body", "author", "createdAt", "updatedAt", ...optional], "reply", optional);
    integer(reply.journalId, "journalId", 1); text(reply.body, "body", 65_535, true); named(reply.author, "author");
    dateTime(reply.createdAt, "createdAt"); if (reply.updatedAt !== null) dateTime(reply.updatedAt, "updatedAt");
    if (reply.messageId !== undefined && !uuidPattern.test(String(reply.messageId))) throw invalid("messageId");
  } else if (item.kind === "activity") {
    const activity = exact(item, ["kind", "journalId", "field", "oldValue", "newValue", "author", "createdAt"], "activity");
    integer(activity.journalId, "journalId", 1);
    if (!activityFields.includes(activity.field as string)) throw invalid("activity field");
    if (activity.oldValue !== null) text(activity.oldValue, "oldValue", 65_535, true);
    if (activity.newValue !== null) text(activity.newValue, "newValue", 65_535, true);
    named(activity.author, "author"); dateTime(activity.createdAt, "createdAt");
  } else if (item.kind === "diagnostic") {
    const diagnostic = exact(item, ["kind", "journalId", "message"], "diagnostic");
    if (diagnostic.journalId !== null) integer(diagnostic.journalId, "journalId", 1);
    text(diagnostic.message, "diagnostic message", 200);
  } else throw invalid("timeline kind");
}

function conversationMessage(value: unknown): void {
  const item = exact(value, ["id", "kind", "journalId", "body", "author", "createdAt", "editedAt", "version", "versions", "canEdit"], "message");
  if (!uuidPattern.test(String(item.id)) || (item.kind !== "initial" && item.kind !== "reply")) throw invalid("message identity");
  if (item.journalId !== null) integer(item.journalId, "journalId", 1);
  text(item.body, "message body", 20_000, true);
  const author = exact(item.author, ["kind", "participantId", "displayName"], "message author");
  if (author.kind !== "participant" && author.kind !== "redmine") throw invalid("message author kind");
  if (author.participantId !== null && !uuidPattern.test(String(author.participantId))) throw invalid("message participantId");
  text(author.displayName, "message displayName", 255);
  dateTime(item.createdAt, "message createdAt");
  if (item.editedAt !== null) dateTime(item.editedAt, "message editedAt");
  integer(item.version, "message version", 1);
  if (!Array.isArray(item.versions) || typeof item.canEdit !== "boolean") throw invalid("message versions/canEdit");
  item.versions.forEach((entry) => {
    const version = exact(entry, ["version", "body", "editedAt"], "message version");
    integer(version.version, "version", 1); text(version.body, "version body", 20_000, true); dateTime(version.editedAt, "version editedAt");
  });
}

function attachment(value: unknown): void {
  const item = exact(value, ["id", "filename", "byteSize", "contentType", "author", "createdAt", "inlinePreview", "primaryEvidence"], "attachment");
  integer(item.id, "attachment ID", 1); text(item.filename, "filename", 255); integer(item.byteSize, "byteSize", 0);
  if (item.contentType !== null) text(item.contentType, "contentType", 255);
  named(item.author, "author"); dateTime(item.createdAt, "createdAt");
  if (typeof item.inlinePreview !== "boolean" || typeof item.primaryEvidence !== "boolean") throw invalid("attachment flag");
}

function named(value: unknown, name: string): void {
  const item = exact(value, ["id", "name"], name);
  integer(item.id, `${name}.id`, 1); text(item.name, `${name}.name`, 255);
}

function exact(value: unknown, keys: readonly string[], name: string, optional: readonly string[] = []): Record<string, unknown> {
  const item = object(value, name);
  const allowed = new Set(keys);
  const unknown = Object.keys(item).find((key) => !allowed.has(key));
  if (unknown) throw invalid(`${name} unknown property: ${unknown}`);
  const missing = keys.find((key) => !optional.includes(key) && !(key in item));
  if (missing) throw invalid(`${name} missing property: ${missing}`);
  return item;
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(name);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, maximum: number, empty = false): void {
  if (typeof value !== "string" || value.length > maximum || (!empty && !value)) throw invalid(name);
}
function integer(value: unknown, name: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw invalid(name);
}
function number(value: unknown, minimum: number, maximum: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw invalid("number");
}
function relative(value: unknown): void { number(value, 0, 1); }
function dateTime(value: unknown, name: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw invalid(name);
}
function stringMap(value: unknown, name: string): void {
  const item = object(value, name);
  if (Object.values(item).some((entry) => typeof entry !== "string")) throw invalid(name);
}
function invalid(name: string): Error { return new Error(`Redmine responseの${name}が不正です`); }

const activityFields = ["status", "assignee", "priority", "tracker", "subject", "description", "attachment"];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
