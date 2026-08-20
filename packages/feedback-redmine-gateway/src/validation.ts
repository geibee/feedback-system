import type {
  FeedbackHostResourceRefV1,
  RedmineEvidenceMetadata,
  RedmineMessageCreateInput,
  RedmineMessageUpdateInput,
  RedmineThreadCreateInput,
  RedmineThreadFilter,
  RedmineThreadSort
} from "@feedback/redmine-core";
import { GatewayHttpError } from "./problem.js";

export function parseResourceQuery(query: URLSearchParams, allowedExtra: readonly string[]): FeedbackHostResourceRefV1 {
  rejectUnknownQuery(query, ["resourceKind", "resourceKey", ...allowedExtra]);
  return resourceRef({
    schemaVersion: "1",
    kind: query.get("resourceKind"),
    key: query.get("resourceKey")
  });
}

export function parseListQuery(query: URLSearchParams): {
  scope?: "resource";
  resourceRef: FeedbackHostResourceRefV1;
  pageKey: string;
  sort: RedmineThreadSort;
  filter: RedmineThreadFilter;
  cursor?: string;
} | {
  scope: "workspace";
  sort: RedmineThreadSort;
  filter: RedmineThreadFilter;
  cursor?: string;
} {
  rejectUnknownQuery(query, [
    "scope", "resourceKind", "resourceKey", "pageKey", "sort", "status", "perspectiveCode", "assigneeId",
    "priorityId", "q", "cursor"
  ]);
  const scope = query.get("scope");
  if (scope !== null && scope !== "resource" && scope !== "workspace") invalid("scopeが不正です");
  const sort = query.get("sort");
  if (sort !== "created_desc" && sort !== "created_asc" && sort !== "updated_desc") invalid("sortが不正です");
  const filter: RedmineThreadFilter = {};
  const status = query.get("status");
  if (status) {
    if (status === "open" || status === "closed") filter.status = status;
    else if (/^[1-9][0-9]*$/u.test(status)) filter.status = Number(status);
    else invalid("status filterが不正です");
  }
  const perspective = query.get("perspectiveCode");
  if (perspective) filter.perspectiveCode = bounded(perspective, "perspectiveCode", 100);
  const assignee = optionalPositiveInteger(query.get("assigneeId"), "assigneeId");
  if (assignee) filter.assigneeId = assignee;
  const priority = optionalPositiveInteger(query.get("priorityId"), "priorityId");
  if (priority) filter.priorityId = priority;
  const q = query.get("q");
  if (q) filter.q = bounded(q, "q", 200);
  const cursor = query.get("cursor");
  if (cursor && cursor.length > 2048) invalid("cursorが長すぎます");
  if (scope === "workspace") {
    if (query.has("resourceKind") || query.has("resourceKey") || query.has("pageKey")) {
      invalid("workspace scopeへresource/page queryは指定できません");
    }
    return { scope: "workspace", sort, filter, ...(cursor ? { cursor } : {}) };
  }
  const resource = resourceRef({
    schemaVersion: "1",
    kind: query.get("resourceKind"),
    key: query.get("resourceKey")
  });
  const pageKey = requiredQuery(query, "pageKey", 100);
  return { ...(scope === "resource" ? { scope } : {}), resourceRef: resource, pageKey, sort, filter, ...(cursor ? { cursor } : {}) };
}

export function parseCreateRequest(value: unknown, profileId: string, requestOrigin: string): RedmineThreadCreateInput {
  const item = exact(value, [
    "resourceRef", "threadId", "intentId", "comment", "perspectiveCode", "location", "target", "release", "locale",
    "threadUrl", "capturedAt", "evidence", "participantName"
  ], "create request", ["threadUrl", "participantName"]);
  const location = exact(item.location, ["schemaVersion", "pageKey", "routeTemplate", "pathParameters", "queryParameters"], "location", ["queryParameters"]);
  if (location.schemaVersion !== "1") invalid("location schemaVersionが不正です");
  stringMap(location.pathParameters, "pathParameters");
  if (location.queryParameters !== undefined) stringMap(location.queryParameters, "queryParameters");
  const target = item.target === null ? null : parseTarget(item.target);
  const evidence = item.evidence === null ? null : parseEvidence(item.evidence);
  const threadId = uuid(item.threadId, "threadId");
  if (evidence && evidence.filename !== `feedback-${threadId}.${evidence.contentType === "image/png" ? "png" : "webp"}`) {
    invalid("evidence filenameとthread IDが一致しません");
  }
  return {
    profileId,
    resourceRef: resourceRef(item.resourceRef),
    threadId,
    intentId: uuid(item.intentId, "intentId"),
    comment: bounded(item.comment, "comment", 20_000),
    perspectiveCode: bounded(item.perspectiveCode, "perspectiveCode", 100),
    location: {
      schemaVersion: "1",
      pageKey: bounded(location.pageKey, "pageKey", 100),
      routeTemplate: bounded(location.routeTemplate, "routeTemplate", 500),
      pathParameters: location.pathParameters as Record<string, string>,
      ...(location.queryParameters ? { queryParameters: location.queryParameters as Record<string, string> } : {})
    },
    target,
    release: bounded(item.release, "release", 100),
    locale: bounded(item.locale, "locale", 35),
    threadUrl: parseThreadUrl(item.threadUrl, threadId, requestOrigin),
    capturedAt: dateTime(item.capturedAt, "capturedAt"),
    evidence,
    participantName: participantName(item.participantName)
  };
}

function parseThreadUrl(value: unknown, threadId: string, requestOrigin: string): string | null {
  if (value === undefined || value === null) return null;
  const text = bounded(value, "threadUrl", 2_048);
  let parsed: URL;
  let origin: URL;
  try {
    parsed = new URL(text);
    origin = new URL(requestOrigin);
  } catch {
    invalid("threadUrlがURLではありません");
  }
  if ((parsed!.protocol !== "https:" && parsed!.protocol !== "http:") || parsed!.origin !== origin!.origin ||
    parsed!.username || parsed!.password || parsed!.searchParams.get("feedbackThread") !== threadId) {
    invalid("threadUrlは同一originでfeedbackThreadを含む必要があります");
  }
  return parsed!.toString();
}

export function parseCreateParticipantRequest(value: unknown): { browserProfileId: string } {
  const item = exact(value, ["browserProfileId"], "participant request");
  return { browserProfileId: uuid(item.browserProfileId, "browserProfileId") };
}

export function parseCreateMessageRequest(
  value: unknown,
  profileId: string,
  threadId: string,
  intentId: string
): RedmineMessageCreateInput {
  const item = exact(value, ["messageId", "body", "participantName"], "message request");
  return {
    profileId,
    threadId,
    intentId,
    resourceRef: { schemaVersion: "1", kind: "page", key: "validated-by-handler" },
    messageId: uuid(item.messageId, "messageId"),
    body: bounded(item.body, "body", 20_000),
    participantName: participantName(item.participantName)
  };
}

export function parseUpdateMessageRequest(
  value: unknown,
  profileId: string,
  threadId: string,
  messageId: string,
  intentId: string
): RedmineMessageUpdateInput {
  const item = exact(value, ["body", "expectedVersion", "participantName"], "message update request");
  return {
    profileId,
    threadId,
    messageId,
    intentId,
    resourceRef: { schemaVersion: "1", kind: "page", key: "validated-by-handler" },
    body: bounded(item.body, "body", 20_000),
    expectedVersion: integer(item.expectedVersion, "expectedVersion", 1, Number.MAX_SAFE_INTEGER),
    participantName: participantName(item.participantName)
  };
}

export function assertEvidencePart(
  metadata: RedmineEvidenceMetadata | null,
  evidence: { bytes: Uint8Array; filename: string; contentType: string } | null
): void {
  if (!metadata && !evidence) return;
  if (!metadata || !evidence || metadata.filename !== evidence.filename ||
    metadata.contentType !== evidence.contentType || metadata.byteSize !== evidence.bytes.byteLength) {
    invalid("evidence partとmetadataが一致しません");
  }
}

function parseEvidence(value: unknown): RedmineEvidenceMetadata {
  const item = exact(value, [
    "filename", "contentType", "byteSize", "sha256", "viewportWidth", "viewportHeight", "pixelRatio", "capturedAt"
  ], "evidence metadata");
  const contentType = item.contentType;
  if (contentType !== "image/png" && contentType !== "image/webp") invalid("evidence content typeが不正です");
  const filename = bounded(item.filename, "evidence filename", 80);
  if (!/^feedback-[0-9a-f-]{36}\.(?:png|webp)$/iu.test(filename)) invalid("evidence filenameが不正です");
  const sha256 = bounded(item.sha256, "evidence sha256", 64);
  if (!/^[a-f0-9]{64}$/u.test(sha256)) invalid("evidence sha256が不正です");
  return {
    filename,
    contentType,
    byteSize: integer(item.byteSize, "byteSize", 1, 10_485_760),
    sha256,
    viewportWidth: integer(item.viewportWidth, "viewportWidth", 1, 32_768),
    viewportHeight: integer(item.viewportHeight, "viewportHeight", 1, 32_768),
    pixelRatio: positiveFinite(item.pixelRatio, "pixelRatio", 16),
    capturedAt: dateTime(item.capturedAt, "evidence capturedAt")
  };
}

function parseTarget(value: unknown): RedmineThreadCreateInput["target"] {
  const item = object(value, "target");
  if (item.schemaVersion !== "1") invalid("target schemaVersionが不正です");
  if (item.kind === "ui-element") {
    exact(item, ["schemaVersion", "kind", "elementKey", "relativeX", "relativeY"], "ui target");
    return { schemaVersion: "1", kind: "ui-element", elementKey: bounded(item.elementKey, "elementKey", 200), relativeX: relative(item.relativeX), relativeY: relative(item.relativeY) };
  }
  if (item.kind === "screen-position") {
    exact(item, ["schemaVersion", "kind", "relativeX", "relativeY"], "screen target");
    return { schemaVersion: "1", kind: "screen-position", relativeX: relative(item.relativeX), relativeY: relative(item.relativeY) };
  }
  if (item.kind === "map-position") {
    exact(item, ["schemaVersion", "kind", "longitude", "latitude"], "map target");
    return { schemaVersion: "1", kind: "map-position", longitude: finite(item.longitude, "longitude", -180, 180), latitude: finite(item.latitude, "latitude", -90, 90) };
  }
  if (item.kind === "map-feature") {
    exact(item, ["schemaVersion", "kind", "provider", "sourceKey", "sourceLayer", "featureKey", "longitude", "latitude"], "map feature target", ["sourceLayer"]);
    if (item.provider !== "maplibre") invalid("map providerが不正です");
    return {
      schemaVersion: "1",
      kind: "map-feature",
      provider: "maplibre",
      sourceKey: bounded(item.sourceKey, "sourceKey", 200),
      ...(item.sourceLayer ? { sourceLayer: bounded(item.sourceLayer, "sourceLayer", 200) } : {}),
      featureKey: bounded(item.featureKey, "featureKey", 200),
      longitude: finite(item.longitude, "longitude", -180, 180),
      latitude: finite(item.latitude, "latitude", -90, 90)
    };
  }
  invalid("target kindが不正です");
}

function resourceRef(value: unknown): FeedbackHostResourceRefV1 {
  const item = exact(value, ["schemaVersion", "kind", "key"], "resourceRef");
  if (item.schemaVersion !== "1" || (item.kind !== "record" && item.kind !== "page")) invalid("resourceRefが不正です");
  return { schemaVersion: "1", kind: item.kind, key: bounded(item.key, "resource key", 500) };
}

function rejectUnknownQuery(query: URLSearchParams, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of query.keys()) {
    if (!allowedSet.has(key) || query.getAll(key).length !== 1) invalid(`query parameterが不正です: ${key}`);
  }
}

function requiredQuery(query: URLSearchParams, name: string, maximum: number): string {
  const value = query.get(name);
  if (!value) invalid(`${name}がありません`);
  return bounded(value, name, maximum);
}

function optionalPositiveInteger(value: string | null, name: string): number | null {
  if (value === null) return null;
  if (!/^[1-9][0-9]*$/u.test(value)) invalid(`${name}が不正です`);
  return Number(value);
}

function exact(value: unknown, keys: readonly string[], name: string, optional: readonly string[] = []): Record<string, unknown> {
  const item = object(value, name);
  const allowed = new Set(keys);
  const unknown = Object.keys(item).find((key) => !allowed.has(key));
  if (unknown) invalid(`${name}にunknown propertyがあります: ${unknown}`);
  const missing = keys.find((key) => !optional.includes(key) && !(key in item));
  if (missing) invalid(`${name}に必須propertyがありません: ${missing}`);
  return item;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${name}がobjectではありません`);
  return value as Record<string, unknown>;
}

function bounded(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum) invalid(`${name}が不正なstringです`);
  return value;
}

function uuid(value: unknown, name: string): string {
  const result = bounded(value, name, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(result)) invalid(`${name}がUUIDではありません`);
  return result;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid(`${name}がintegerではありません`);
  return value as number;
}

function finite(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) invalid(`${name}がnumberではありません`);
  return value;
}

function positiveFinite(value: unknown, name: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) invalid(`${name}がpositive numberではありません`);
  return value;
}

function relative(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) invalid("relative座標が不正です");
  return value;
}

function dateTime(value: unknown, name: string): string {
  const result = bounded(value, name, 100);
  if (!Number.isFinite(Date.parse(result))) invalid(`${name}がdate-timeではありません`);
  return result;
}

function participantName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return bounded(value, "participantName", 100);
}

function stringMap(value: unknown, name: string): void {
  const item = object(value, name);
  if (Object.values(item).some((entry) => typeof entry !== "string")) invalid(`${name}がstring mapではありません`);
}

function invalid(message: string): never {
  throw new GatewayHttpError(400, "redmine.contract_invalid", message);
}
