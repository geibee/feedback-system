import {
  canonicalJson,
  decodeListCursor,
  diagnosticErrorCode,
  encodeListCursor,
  RedmineDiagnosticBuffer,
  RedmineFeedbackError,
  sha256Hex,
  type RedmineEvidenceMetadata,
  type RedmineThreadCreateInput,
  type RedmineThreadFilter,
  type RedmineThreadSort
} from "@feedback/redmine-core";
import { RedmineTrustedClient, type RedmineFetch } from "@feedback/redmine-core/trusted";
import { toConnectorProfile, type ExtensionProfileV1 } from "../profile.js";
import { ExtensionProfileRepository } from "../storage/chrome-storage.js";
import { CredentialVault } from "./credential-vault.js";
import { EvidenceStaging, rawChunkSize } from "./evidence-staging.js";

export type ExtensionSender = {
  id?: string;
  url?: string;
  tab?: { url?: string };
};

type OperationType =
  | "redmine.profile.get.v1"
  | "redmine.current-user.get.v1"
  | "redmine.thread.list.v1"
  | "redmine.thread.get.v1"
  | "redmine.thread.create.v1"
  | "redmine.attachment.get.v1"
  | "profile.unlock.v1"
  | "profile.lock.v1"
  | "diagnostic.download.v1";

type OperationRequest = {
  contractVersion: "1";
  requestId: string;
  type: OperationType;
  payload: Record<string, unknown>;
};

export type OperationResponse = {
  contractVersion: "1";
  requestId: string;
  type: OperationType;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; retryable: boolean; upstreamStatus: number | null; requestId: string };
};

export class ExtensionMessageHandler {
  constructor(
    private readonly runtimeId: string,
    private readonly profiles: ExtensionProfileRepository,
    private readonly vault: CredentialVault,
    private readonly evidence: EvidenceStaging,
    private readonly fetch: RedmineFetch = (input, init) => globalThis.fetch(input, init),
    private readonly diagnostics = new RedmineDiagnosticBuffer(),
    private readonly allowHttpDevelopment = false
  ) {}

  async handle(message: unknown, sender: ExtensionSender): Promise<OperationResponse> {
    let request: OperationRequest | null = null;
    let httpStatus: number | null = null;
    let errorCode: ReturnType<typeof diagnosticErrorCode> | null = null;
    const started = performance.now();
    try {
      request = parseRequest(message);
      const profileId = requiredString(request.payload.profileId, "profileId", 100);
      const profile = await this.requireProfile(profileId);
      this.authorizeSender(
        sender,
        profile,
        request.type === "profile.unlock.v1" || request.type === "profile.lock.v1" || request.type === "diagnostic.download.v1"
      );
      const trackedFetch: RedmineFetch = async (input, init) => {
        const response = await this.fetch(input, init);
        httpStatus = response.status;
        return response;
      };
      const result = await this.dispatch(request, profile, trackedFetch);
      return success(request, result);
    } catch (error) {
      errorCode = diagnosticErrorCode(error);
      const response = await this.failure(message, error);
      if (httpStatus === null && response.error?.upstreamStatus) httpStatus = response.error.upstreamStatus;
      return response;
    } finally {
      if (request && request.type !== "diagnostic.download.v1") {
        this.diagnostics.record({
          requestId: request.requestId,
          operation: request.type,
          profileId: typeof request.payload.profileId === "string" ? request.payload.profileId : "unknown",
          httpStatus,
          durationMilliseconds: performance.now() - started,
          errorCode
        });
      }
    }
  }

  async failure(message: unknown, error: unknown): Promise<OperationResponse> {
    const fallback = requestLike(message);
    const normalized = normalizeError(error);
    if (normalized.code === "redmine.invalid_api_key") {
      const profileId = fallback.payload && typeof fallback.payload.profileId === "string" ? fallback.payload.profileId : null;
      if (profileId) await this.vault.lock(profileId).catch(() => undefined);
    }
    return failure(fallback, normalized);
  }

  async bootstrap(sender: ExtensionSender): Promise<OperationResponse> {
    const started = performance.now();
    const request: OperationRequest = {
      contractVersion: "1",
      requestId: crypto.randomUUID(),
      type: "redmine.profile.get.v1",
      payload: {}
    };
    try {
      if (sender.id !== this.runtimeId || !sender.tab?.url) throw permissionError();
      const origin = new URL(sender.tab.url).origin;
      const profile = (await this.profiles.list()).find((candidate) => candidate.hostOrigins.includes(origin));
      if (!profile) throw new RedmineFeedbackError("redmine.not_found", "このoriginに有効なprofileがありません");
      const result = success(request, await this.profileResult(profile));
      this.diagnostics.record({
        requestId: request.requestId,
        operation: request.type,
        profileId: profile.id,
        httpStatus: null,
        durationMilliseconds: performance.now() - started,
        errorCode: null
      });
      return result;
    } catch (error) {
      return failure(request, normalizeError(error));
    }
  }

  async getAttachment(message: unknown, sender: ExtensionSender, signal: AbortSignal) {
    let request: OperationRequest | null = null;
    let httpStatus: number | null = null;
    let errorCode: ReturnType<typeof diagnosticErrorCode> | null = null;
    const started = performance.now();
    try {
      request = parseRequest(message);
      if (request.type !== "redmine.attachment.get.v1") throw new Error("attachment operationではありません");
      const profile = await this.requireProfile(requiredString(request.payload.profileId, "profileId", 100));
      this.authorizeSender(sender, profile, false);
      const key = await this.requireKey(profile.id);
      const resourceRef = parseResource(request.payload.resourceRef);
      const trackedFetch: RedmineFetch = async (input, init) => {
        const response = await this.fetch(input, init);
        httpStatus = response.status;
        return response;
      };
      const client = new RedmineTrustedClient({
        profile: toConnectorProfile(profile, this.allowHttpDevelopment), apiKey: key, fetch: trackedFetch,
        allowHttpDevelopment: this.allowHttpDevelopment
      });
      const content = await client.getAttachment({
        hostResourceKey: await resourceHash(resourceRef),
        threadId: uuid(request.payload.threadId, "threadId"),
        attachmentId: integer(request.payload.attachmentId, "attachmentId", 1)
      }, signal);
      return { request, content };
    } catch (error) {
      errorCode = diagnosticErrorCode(error);
      const profileId = request && typeof request.payload.profileId === "string" ? request.payload.profileId : null;
      if (profileId && error instanceof RedmineFeedbackError && error.code === "redmine.invalid_api_key") await this.vault.lock(profileId);
      throw error;
    } finally {
      if (request) this.diagnostics.record({
        requestId: request.requestId,
        operation: request.type,
        profileId: typeof request.payload.profileId === "string" ? request.payload.profileId : "unknown",
        httpStatus,
        durationMilliseconds: performance.now() - started,
        errorCode
      });
    }
  }

  async authorizeEvidenceStart(profileIdValue: unknown, metadataValue: unknown, sender: ExtensionSender): Promise<RedmineEvidenceMetadata> {
    const profile = await this.requireProfile(requiredString(profileIdValue, "profileId", 100));
    this.authorizeSender(sender, profile, false);
    const metadata = parseEvidence(metadataValue);
    if (metadata.byteSize > profile.capture.maximumUploadBytes || !profile.capture.contentTypes.includes(metadata.contentType)) {
      throw new RedmineFeedbackError("redmine.payload_too_large", "evidenceがprofile上限または許可MIMEに一致しません");
    }
    return metadata;
  }

  private async dispatch(request: OperationRequest, profile: ExtensionProfileV1, fetch: RedmineFetch): Promise<unknown> {
    if (request.type === "diagnostic.download.v1") {
      exact(request.payload, ["profileId"], "diagnostic payload");
      return this.diagnostics.document();
    }
    if (request.type === "profile.unlock.v1") {
      exact(request.payload, ["profileId", "apiKey"], "unlock payload");
      const apiKey = requiredString(request.payload.apiKey, "apiKey", 255);
      const client = new RedmineTrustedClient({
        profile: toConnectorProfile(profile, this.allowHttpDevelopment), apiKey, fetch,
        allowHttpDevelopment: this.allowHttpDevelopment
      });
      const validation = await client.validateConnection();
      await this.vault.unlock(profile.id, apiKey);
      return { profileId: profile.id, locked: false, customFieldValidation: validation.customFields };
    }
    if (request.type === "profile.lock.v1") {
      exact(request.payload, ["profileId"], "lock payload");
      await this.vault.lock(profile.id);
      return { profileId: profile.id, locked: true };
    }
    if (request.type === "redmine.profile.get.v1") {
      exact(request.payload, ["profileId"], "profile payload");
      return this.profileResult(profile);
    }
    const key = await this.requireKey(profile.id);
    const client = new RedmineTrustedClient({
      profile: toConnectorProfile(profile, this.allowHttpDevelopment), apiKey: key, fetch,
      allowHttpDevelopment: this.allowHttpDevelopment
    });
    if (request.type === "redmine.current-user.get.v1") {
      exact(request.payload, ["profileId"], "current user payload");
      const user = await client.getCurrentUser();
      return { principal: { subjectId: String(user.id), displayName: user.name, redmineUserId: user.id, source: "redmine-api-key" } };
    }
    if (request.type === "redmine.thread.list.v1") {
      exact(request.payload, ["profileId", "resourceRef", "pageKey", "sort", "filter", "cursor"], "list payload", ["filter", "cursor"]);
      const resourceRef = parseResource(request.payload.resourceRef);
      const hostResourceKey = await resourceHash(resourceRef);
      const pageKey = requiredString(request.payload.pageKey, "pageKey", 100);
      const sort = parseSort(request.payload.sort);
      const filter = parseFilter(request.payload.filter);
      const cursorInput = { v: "1" as const, profileId: profile.id, hostResourceKey, pageKey, filter, sort };
      const offset = request.payload.cursor ? decodeListCursor(requiredString(request.payload.cursor, "cursor", 2048), cursorInput).offset : 0;
      const result = await client.listThreads({ hostResourceKey, pageKey, sort, filter, offset });
      return {
        threads: result.threads,
        nextCursor: result.nextOffset !== null
          ? encodeListCursor({ ...cursorInput, offset: result.nextOffset })
          : null
      };
    }
    if (request.type === "redmine.thread.get.v1") {
      exact(request.payload, ["profileId", "resourceRef", "threadId"], "thread payload");
      return { thread: await client.getThread({
        hostResourceKey: await resourceHash(parseResource(request.payload.resourceRef)),
        threadId: uuid(request.payload.threadId, "threadId")
      }) };
    }
    if (request.type === "redmine.thread.create.v1") {
      const input = parseCreate(request.payload);
      if (!profile.perspectives.some((perspective) => perspective.code === input.perspectiveCode)) {
        throw new RedmineFeedbackError("redmine.contract_invalid", "perspectiveがprofileにありません");
      }
      const user = await client.getCurrentUser();
      const bytes = this.evidence.take(request.requestId, input.evidence);
      return { thread: await client.createThread({
        ...input,
        hostResourceKey: await resourceHash(input.resourceRef),
        author: { source: "redmine-api-key", subjectId: String(user.id), displayName: user.name, redmineUserId: user.id },
        submissionChannel: "extension"
      }, bytes) };
    }
    throw new RedmineFeedbackError("redmine.contract_invalid", "attachmentは専用Portで取得してください");
  }

  private async profileResult(profile: ExtensionProfileV1) {
    const locked = !await this.vault.get(profile.id);
    const connector = toConnectorProfile(profile);
    return {
      profile: connector.clientProfile,
      capabilities: { canRead: !locked, canCreate: !locked, repliesReadOnly: true, stateReadOnly: true }
    };
  }

  private async requireProfile(profileId: string): Promise<ExtensionProfileV1> {
    const profile = await this.profiles.get(profileId);
    if (!profile) throw new RedmineFeedbackError("redmine.not_found", "profileが見つかりません");
    return profile;
  }

  private async requireKey(profileId: string): Promise<string> {
    const key = await this.vault.get(profileId);
    if (!key) throw new RedmineFeedbackError("redmine.unauthenticated", "Redmine API keyをoptionsでunlockしてください");
    return key;
  }

  private authorizeSender(sender: ExtensionSender, profile: ExtensionProfileV1, optionsOnly: boolean): void {
    if (sender.id !== this.runtimeId) throw permissionError();
    const extensionOrigin = `chrome-extension://${this.runtimeId}`;
    if (sender.url?.startsWith(`${extensionOrigin}/`)) return;
    if (optionsOnly || !sender.tab?.url) throw permissionError();
    let origin: string;
    try { origin = new URL(sender.tab.url).origin; } catch { throw permissionError(); }
    if (!profile.hostOrigins.includes(origin)) throw permissionError();
  }
}

function parseRequest(value: unknown): OperationRequest {
  const item = exact(value, ["contractVersion", "requestId", "type", "payload"], "operation request");
  if (item.contractVersion !== "1" || !operationTypes.includes(item.type as OperationType)) throw new Error("operation type/versionが不正です");
  return {
    contractVersion: "1",
    requestId: uuid(item.requestId, "requestId"),
    type: item.type as OperationType,
    payload: exact(item.payload, Object.keys(item.payload as object), "operation payload")
  };
}

function parseCreate(value: unknown): RedmineThreadCreateInput {
  const item = exact(value, [
    "profileId", "resourceRef", "threadId", "intentId", "comment", "perspectiveCode", "location", "target", "release", "locale",
    "capturedAt", "evidence"
  ], "create payload");
  const location = exact(item.location, ["schemaVersion", "pageKey", "routeTemplate", "pathParameters", "queryParameters"], "location", ["queryParameters"]);
  if (location.schemaVersion !== "1") throw new Error("location schemaVersionが不正です");
  stringMap(location.pathParameters, "pathParameters");
  if (location.queryParameters !== undefined) stringMap(location.queryParameters, "queryParameters");
  const evidence = item.evidence === null ? null : parseEvidence(item.evidence);
  const threadId = uuid(item.threadId, "threadId");
  if (evidence && evidence.filename !== `feedback-${threadId}.${evidence.contentType === "image/png" ? "png" : "webp"}`) {
    throw new Error("evidence filenameとthread IDが一致しません");
  }
  return {
    profileId: requiredString(item.profileId, "profileId", 100),
    resourceRef: parseResource(item.resourceRef),
    threadId,
    intentId: uuid(item.intentId, "intentId"),
    comment: requiredString(item.comment, "comment", 20_000),
    perspectiveCode: requiredString(item.perspectiveCode, "perspectiveCode", 100),
    location: {
      schemaVersion: "1",
      pageKey: requiredString(location.pageKey, "pageKey", 100),
      routeTemplate: requiredString(location.routeTemplate, "routeTemplate", 500),
      pathParameters: location.pathParameters as Record<string, string>,
      ...(location.queryParameters === undefined ? {} : { queryParameters: location.queryParameters as Record<string, string> })
    },
    target: parseTarget(item.target),
    release: requiredString(item.release, "release", 100),
    locale: requiredString(item.locale, "locale", 35),
    capturedAt: dateTime(item.capturedAt, "capturedAt"),
    evidence
  };
}

function parseTarget(value: unknown): RedmineThreadCreateInput["target"] {
  if (value === null) return null;
  const item = exact(value, Object.keys(value as object), "target");
  if (item.schemaVersion !== "1") throw new Error("target schemaVersionが不正です");
  if (item.kind === "screen-position") {
    exact(item, ["schemaVersion", "kind", "relativeX", "relativeY"], "screen target");
    return { schemaVersion: "1", kind: "screen-position", relativeX: relative(item.relativeX), relativeY: relative(item.relativeY) };
  }
  if (item.kind === "ui-element") {
    exact(item, ["schemaVersion", "kind", "elementKey", "relativeX", "relativeY"], "ui target");
    return { schemaVersion: "1", kind: "ui-element", elementKey: requiredString(item.elementKey, "elementKey", 200), relativeX: relative(item.relativeX), relativeY: relative(item.relativeY) };
  }
  if (item.kind === "map-position") {
    exact(item, ["schemaVersion", "kind", "longitude", "latitude"], "map target");
    return { schemaVersion: "1", kind: "map-position", longitude: coordinate(item.longitude, -180, 180), latitude: coordinate(item.latitude, -90, 90) };
  }
  if (item.kind === "map-feature") {
    exact(item, ["schemaVersion", "kind", "provider", "sourceKey", "sourceLayer", "featureKey", "longitude", "latitude"], "map feature target", ["sourceLayer"]);
    if (item.provider !== "maplibre") throw new Error("map providerが不正です");
    return {
      schemaVersion: "1", kind: "map-feature", provider: "maplibre",
      sourceKey: requiredString(item.sourceKey, "sourceKey", 200),
      ...(item.sourceLayer === undefined ? {} : { sourceLayer: requiredString(item.sourceLayer, "sourceLayer", 200) }),
      featureKey: requiredString(item.featureKey, "featureKey", 200),
      longitude: coordinate(item.longitude, -180, 180), latitude: coordinate(item.latitude, -90, 90)
    };
  }
  throw new Error("target kindが不正です");
}

function parseEvidence(value: unknown): RedmineEvidenceMetadata {
  const item = exact(value, ["filename", "contentType", "byteSize", "sha256", "viewportWidth", "viewportHeight", "pixelRatio", "capturedAt"], "evidence");
  const contentType = item.contentType;
  if (contentType !== "image/png" && contentType !== "image/webp") throw new Error("evidence content typeが不正です");
  const filename = requiredString(item.filename, "filename", 80);
  if (!/^feedback-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|webp)$/iu.test(filename)) {
    throw new Error("evidence filenameが不正です");
  }
  return {
    filename, contentType,
    byteSize: integer(item.byteSize, "byteSize", 1, 10_485_760),
    sha256: hex(item.sha256, "sha256"),
    viewportWidth: integer(item.viewportWidth, "viewportWidth", 1, 32_768),
    viewportHeight: integer(item.viewportHeight, "viewportHeight", 1, 32_768),
    pixelRatio: coordinate(item.pixelRatio, Number.EPSILON, 16),
    capturedAt: dateTime(item.capturedAt, "capturedAt")
  };
}

function parseResource(value: unknown): { schemaVersion: "1"; kind: "record" | "page"; key: string } {
  const item = exact(value, ["schemaVersion", "kind", "key"], "resourceRef");
  if (item.schemaVersion !== "1" || (item.kind !== "record" && item.kind !== "page")) throw new Error("resourceRefが不正です");
  return { schemaVersion: "1", kind: item.kind, key: requiredString(item.key, "resource key", 500) };
}

function parseFilter(value: unknown): RedmineThreadFilter {
  if (value === undefined) return {};
  const item = exact(value, ["status", "perspectiveCode", "assigneeId", "priorityId", "q"], "filter", ["status", "perspectiveCode", "assigneeId", "priorityId", "q"]);
  const result: RedmineThreadFilter = {};
  if (item.status !== undefined) {
    if (item.status === "open" || item.status === "closed") result.status = item.status;
    else result.status = integer(item.status, "status", 1);
  }
  if (item.perspectiveCode !== undefined) result.perspectiveCode = requiredString(item.perspectiveCode, "perspectiveCode", 100);
  if (item.assigneeId !== undefined) result.assigneeId = integer(item.assigneeId, "assigneeId", 1);
  if (item.priorityId !== undefined) result.priorityId = integer(item.priorityId, "priorityId", 1);
  if (item.q !== undefined) result.q = requiredString(item.q, "q", 200);
  return result;
}

function parseSort(value: unknown): RedmineThreadSort {
  if (value !== "created_desc" && value !== "created_asc" && value !== "updated_desc") throw new Error("sortが不正です");
  return value;
}

async function resourceHash(resource: object): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson(resource)));
}

function success(request: OperationRequest, result: unknown): OperationResponse {
  return { contractVersion: "1", requestId: request.requestId, type: request.type, ok: true, result };
}

function failure(request: OperationRequest, error: ReturnType<typeof normalizeError>): OperationResponse {
  return {
    contractVersion: "1", requestId: request.requestId, type: request.type, ok: false,
    error: { ...error, requestId: request.requestId }
  };
}

function normalizeError(error: unknown) {
  if (error instanceof RedmineFeedbackError) {
    return { code: error.code, message: error.message.slice(0, 500), retryable: error.retryable, upstreamStatus: error.upstreamStatus };
  }
  return { code: "redmine.contract_invalid", message: "extension requestが不正です", retryable: false, upstreamStatus: null };
}

function requestLike(value: unknown): OperationRequest {
  const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    contractVersion: "1",
    requestId: typeof item.requestId === "string" && uuidPattern.test(item.requestId) ? item.requestId : crypto.randomUUID(),
    type: operationTypes.includes(item.type as OperationType) ? item.type as OperationType : "redmine.profile.get.v1",
    payload: item.payload && typeof item.payload === "object" && !Array.isArray(item.payload) ? item.payload as Record<string, unknown> : {}
  };
}

function exact(value: unknown, keys: readonly string[], name: string, optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name}がobjectではありません`);
  const item = value as Record<string, unknown>;
  const allowed = new Set(keys);
  const unknown = Object.keys(item).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${name}にunknown propertyがあります: ${unknown}`);
  const missing = keys.find((key) => !optional.includes(key) && !(key in item));
  if (missing) throw new Error(`${name}に必須propertyがありません: ${missing}`);
  return item;
}

function requiredString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum) throw new Error(`${name}が不正です`);
  return value;
}

function uuid(value: unknown, name: string): string {
  const result = requiredString(value, name, 36);
  if (!uuidPattern.test(result)) throw new Error(`${name}がUUIDではありません`);
  return result;
}

function integer(value: unknown, name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${name}がintegerではありません`);
  return value as number;
}

function coordinate(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error("座標が不正です");
  return value;
}

function relative(value: unknown): number { return coordinate(value, 0, 1); }
function hex(value: unknown, name: string): string {
  const result = requiredString(value, name, 64);
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new Error(`${name}がSHA-256ではありません`);
  return result;
}
function dateTime(value: unknown, name: string): string {
  const result = requiredString(value, name, 100);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${name}がdate-timeではありません`);
  return result;
}
function stringMap(value: unknown, name: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    throw new Error(`${name}がstring mapではありません`);
  }
}
function permissionError() { return new RedmineFeedbackError("redmine.permission_denied", "extension senderに権限がありません"); }

export { rawChunkSize };
const operationTypes: OperationType[] = [
  "redmine.profile.get.v1", "redmine.current-user.get.v1", "redmine.thread.list.v1", "redmine.thread.get.v1",
  "redmine.thread.create.v1", "redmine.attachment.get.v1", "profile.unlock.v1", "profile.lock.v1", "diagnostic.download.v1"
];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
