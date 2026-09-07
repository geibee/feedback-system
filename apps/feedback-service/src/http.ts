import { randomUUID } from "node:crypto";
import type {
  FeedbackAppendRevisionCommandV2,
  FeedbackCreateThreadCommandV2,
  FeedbackOperationV2,
  FeedbackReplyCommandV2,
  FeedbackResourceRefV2,
  FeedbackUploadAttachmentCommandV2
} from "@geibee/feedback-contracts/v2";
import type { FeedbackProviderProfileV2 } from "@geibee/feedback-contracts/v2/server";
import { FeedbackConnectorProblem, type FeedbackAbortSignal, type FeedbackUploadStreamSource } from "@geibee/feedback-connector-sdk";
import {
  FeedbackGatewayApplicationService,
  FeedbackGatewayProblem,
  type FeedbackAuthorizationTarget,
  type FeedbackGatewayAccess
} from "@geibee/feedback-gateway";
import type { FeedbackAuthorizationRuntime } from "./authorization.js";
import type { FeedbackProfileLoaderPort } from "@geibee/feedback-gateway";
import type { FeedbackSecretResolver } from "./configuration.js";
import {
  assertCurrentParticipantOwnsMessage,
  assertParticipantOwnsMessage,
  issueFeedbackParticipantCredential,
  verifyFeedbackParticipantCredential,
  type FeedbackParticipantPrincipal
} from "./participant.js";

export type FeedbackHttpRequestContext = {
  authenticatedSubjectId?: string;
};

export type FeedbackHttpAdapterDependencies = {
  gateway: FeedbackGatewayApplicationService;
  authorization: FeedbackAuthorizationRuntime;
  profileLoader: FeedbackProfileLoaderPort;
  secretResolver: FeedbackSecretResolver;
  expectedOrigin: string;
  basePath: string;
  maximumRequestBytes: number;
  operationTimeoutMilliseconds: number;
  bindParticipant?: (input: {
    access: FeedbackGatewayAccess;
    principal: FeedbackParticipantPrincipal | null;
  }) => void;
  metric?: (event: {
    operation: string;
    profileId: string | null;
    status: number;
    durationMilliseconds: number;
    traceId: string;
  }) => void;
};

type Route = {
  operation: string;
  permission: FeedbackOperationV2;
  kind: "participant" | "profile" | "workspaces" | "resources" | "threads" | "thread" | "reply" | "revision" | "upload" | "download" | "intent";
  profileId: string;
  workspaceId?: string;
  threadId?: string;
  messageId?: string;
  attachmentId?: string;
  intentId?: string;
};

const stableKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const requestHashPattern = /^sha256:[a-f0-9]{64}$/u;

export function createFeedbackHttpHandler(dependencies: FeedbackHttpAdapterDependencies) {
  const expectedOrigin = normalizeExpectedOrigin(dependencies.expectedOrigin);
  const basePath = normalizeBasePath(dependencies.basePath);
  if (!Number.isInteger(dependencies.maximumRequestBytes) || dependencies.maximumRequestBytes < 1024) {
    throw new Error("maximumRequestBytesが不正です");
  }
  if (!Number.isInteger(dependencies.operationTimeoutMilliseconds) || dependencies.operationTimeoutMilliseconds < 100 || dependencies.operationTimeoutMilliseconds > 60_000) {
    throw new Error("operationTimeoutMillisecondsが不正です");
  }

  return async (request: Request, context: FeedbackHttpRequestContext = {}): Promise<Response> => {
    const traceId = randomUUID();
    const started = performance.now();
    let route: Route | null = null;
    let status = 500;
    const deadline = createDeadlineSignal(request.signal, dependencies.operationTimeoutMilliseconds);
    try {
      validateOrigin(request, expectedOrigin);
      route = parseRoute(request, basePath);
      const response = await Promise.race([
        dispatch(request, route, context, deadline.signal, expectedOrigin, dependencies),
        deadline.expiration
      ]);
      status = response.status;
      return secureResponse(response);
    } catch (error) {
      const problem = deadline.timedOut()
        ? new FeedbackGatewayProblem({ code: "feedback.provider_timeout", status: 504, retryable: true, message: "operationがtimeoutしました" })
        : normalizeProblem(error);
      status = problem.status;
      return problemResponse(problem, traceId);
    } finally {
      deadline.dispose();
      if (route && dependencies.metric) {
        try {
          dependencies.metric({
            operation: route.operation,
            profileId: route.profileId,
            status,
            durationMilliseconds: performance.now() - started,
            traceId
          });
        } catch {
          // metric sinkの障害や入力値をresponseへ伝播させない。
        }
      }
    }
  };
}

async function dispatch(
  request: Request,
  route: Route,
  context: FeedbackHttpRequestContext,
  signal: FeedbackAbortSignal,
  expectedOrigin: string,
  dependencies: FeedbackHttpAdapterDependencies
): Promise<Response> {
  const url = new URL(request.url);
  const query = strictQuery(url.searchParams, allowedQuery(route, request.method));
  if (route.kind === "participant") {
    const profile = await loadProfile(dependencies.profileLoader, route.profileId);
    if (profile.authorization.mode !== "public-profile") {
      throw new FeedbackGatewayProblem({ code: "feedback.forbidden", status: 403, message: "public-profile以外ではparticipant credentialを発行できません" });
    }
    const input = validateParticipantRequest(await readJson(request, dependencies.maximumRequestBytes));
    return jsonResponse(await issueFeedbackParticipantCredential({
      profile,
      browserProfileId: input.browserProfileId,
      origin: expectedOrigin,
      secretResolver: dependencies.secretResolver
    }), 201);
  }
  const createCommand = route.kind === "threads" && request.method === "POST"
    ? validateCreateCommand(await readJson(request, dependencies.maximumRequestBytes))
    : null;
  const target = targetFor(route, query, createCommand?.resource);
  const profileForDiscovery = route.kind === "profile" ? await loadProfile(dependencies.profileLoader, route.profileId) : null;
  const requestedOperations = profileForDiscovery?.authorization.mode === "remote-authorization"
    ? [...new Set([route.permission, ...profileForDiscovery.policy.operations.filter(
      (operation) => profileForDiscovery.capabilities.operations.includes(operation)
    )])] : [route.permission];
  const access = await dependencies.authorization.createAccess({
    profileId: route.profileId,
    target,
    requestedOperations,
    bearerToken: bearerToken(request.headers.get("authorization")),
    authenticatedSubjectId: context.authenticatedSubjectId,
    signal
  });
  const reference = request.headers.get("x-feedback-thread-reference");
  const accept = request.headers.get("x-feedback-accept-thread-reference");
  if (accept !== null && accept !== "1") throw invalid("参照拡張headerが不正です");
  if (reference !== null) {
    if (!["thread", "reply", "revision", "upload", "download", "intent"].includes(route.kind) ||
        reference.length > 8192 || !/^ftr1\.[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(reference)) {
      throw invalid("thread参照headerが不正です");
    }
    access.threadReference = reference;
  }
  access.acceptThreadReferences = accept === "1";
  const participant = await resolveAndBindParticipant(
    request,
    route,
    access,
    expectedOrigin,
    dependencies
  );
  const resource = target.level === "resource" ? target.resource : undefined;

  if (route.kind === "profile") {
    return jsonResponse({ profile: await dependencies.gateway.getProfile({
      profileId: route.profileId,
      workspaceId: requiredString(query.workspaceId, "workspaceId"),
      resource: resource!,
      access
    }) });
  }
  if (route.kind === "workspaces") {
    return jsonResponse(await dependencies.gateway.listWorkspaces({
      profileId: route.profileId,
      cursor: query.cursor,
      access
    }));
  }
  if (route.kind === "resources") {
    return jsonResponse(await dependencies.gateway.listResources({
      profileId: route.profileId,
      workspaceId: route.workspaceId!,
      query: query.query,
      cursor: query.cursor,
      access
    }));
  }
  if (route.kind === "threads" && request.method === "GET") {
    return jsonResponse(await dependencies.gateway.listThreads({
      profileId: route.profileId,
      workspaceId: route.workspaceId!,
      resource: resource!,
      order: parseOrder(query.order),
      cursor: query.cursor,
      access
    }));
  }
  if (route.kind === "threads") {
    const command = createCommand!;
    const commandResource = command.resource;
    if (!sameResource(commandResource, resource!)) throw invalid("command resourceとquery scopeが一致しません");
    const result = await dependencies.gateway.createThread({
      profileId: route.profileId,
      workspaceId: route.workspaceId!,
      resource: resource!,
      command,
      access
    });
    return jsonResponse(result, commandStatus(result));
  }
  if (route.kind === "thread") {
    return jsonResponse({ thread: await dependencies.gateway.getThread({
      profileId: route.profileId,
      workspaceId: route.workspaceId!,
      resource: resource!,
      threadId: route.threadId!,
      access
    }) });
  }
  if (route.kind === "reply") {
    const command = validateReplyCommand(await readJson(request, dependencies.maximumRequestBytes));
    const result = await dependencies.gateway.reply({
      profileId: route.profileId,
      workspaceId: route.workspaceId!,
      resource: resource!,
      threadId: route.threadId!,
      command,
      access
    });
    return jsonResponse(result, commandStatus(result));
  }
  if (route.kind === "revision") {
    // 所有者確認用readとrevisionは別々の認可要求へ束縛する。
    const readAccess = await dependencies.authorization.createAccess({
      profileId: route.profileId, target, requestedOperations: ["feedback:read"],
      bearerToken: bearerToken(request.headers.get("authorization")),
      authenticatedSubjectId: context.authenticatedSubjectId, signal
    });
    readAccess.threadReference = access.threadReference;
    readAccess.acceptThreadReferences = access.acceptThreadReferences;
    dependencies.bindParticipant?.({ access: readAccess, principal: participant });
    const thread = await dependencies.gateway.getThread({
      profileId: route.profileId,
      workspaceId: route.workspaceId!,
      resource: resource!,
      threadId: route.threadId!,
      access: readAccess
    });
    if (participant) {
      assertParticipantOwnsMessage({ thread, messageId: route.messageId!, participantId: participant.participantId });
    } else {
      assertCurrentParticipantOwnsMessage({ thread, messageId: route.messageId! });
    }
    const command = validateRevisionCommand(await readJson(request, dependencies.maximumRequestBytes));
    const result = await dependencies.gateway.appendRevision({
      profileId: route.profileId,
      workspaceId: route.workspaceId!,
      resource: resource!,
      threadId: route.threadId!,
      messageId: route.messageId!,
      command,
      access
    });
    return jsonResponse(result, commandStatus(result));
  }
  if (route.kind === "upload") {
    const { command, source } = await readUpload(request, dependencies.maximumRequestBytes);
    const result = await dependencies.gateway.uploadAttachment({
      profileId: route.profileId,
      workspaceId: route.workspaceId!,
      resource: resource!,
      threadId: route.threadId!,
      command,
      source,
      access
    });
    return jsonResponse(result, commandStatus(result));
  }
  if (route.kind === "download") {
    const download = await dependencies.gateway.getAttachment({
      profileId: route.profileId,
      workspaceId: route.workspaceId!,
      resource: resource!,
      threadId: route.threadId!,
      attachmentId: route.attachmentId!,
      access
    });
    return new Response(asyncIterableBody(download.body), {
      headers: {
        "content-type": download.contentType,
        "content-length": String(download.sizeBytes),
        "content-disposition": contentDisposition(download.filename)
      }
    });
  }
  if (route.kind === "intent") {
    const operation = parseRecoverableOperation(requiredString(query.operation, "operation"));
    if (operation !== route.permission) throw invalid("intent operationがroute permissionと一致しません");
    return jsonResponse(await dependencies.gateway.recoverIntent({
      profileId: route.profileId,
      workspaceId: route.workspaceId!,
      resource: resource!,
      threadId: requiredUuid(query.threadId, "threadId"),
      intentId: route.intentId!,
      requestHash: requiredHash(request.headers.get("x-feedback-request-hash"), "X-Feedback-Request-Hash"),
      operation,
      access
    }));
  }
  throw new FeedbackGatewayProblem({ code: "feedback.not_found", status: 404, message: "routeが見つかりません" });
}

async function resolveAndBindParticipant(
  request: Request,
  route: Route,
  access: FeedbackGatewayAccess,
  origin: string,
  dependencies: FeedbackHttpAdapterDependencies
): Promise<FeedbackParticipantPrincipal | null> {
  const profile = await loadProfile(dependencies.profileLoader, route.profileId);
  if (profile.authorization.mode !== "public-profile") {
    dependencies.bindParticipant?.({ access, principal: null });
    return null;
  }
  const credential = request.headers.get("x-feedback-participant-credential");
  if (!credential) {
    if (route.permission !== "feedback:read") {
      throw new FeedbackGatewayProblem({ code: "feedback.forbidden", status: 403, message: "participant credentialが必要です" });
    }
    dependencies.bindParticipant?.({ access, principal: null });
    return null;
  }
  const principal = await verifyFeedbackParticipantCredential({
    profile,
    credential,
    origin,
    secretResolver: dependencies.secretResolver
  });
  dependencies.bindParticipant?.({ access, principal });
  return principal;
}

async function loadProfile(loader: FeedbackProfileLoaderPort, profileId: string): Promise<FeedbackProviderProfileV2> {
  const profile = (await loader.loadProfiles()).find((candidate) => candidate.profileId === profileId);
  if (!profile) throw new FeedbackGatewayProblem({ code: "feedback.not_found", status: 404, message: "provider profileが見つかりません" });
  return profile;
}

function parseRoute(request: Request, basePath: string): Route {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${basePath}/`)) throw notFound();
  let parts: string[];
  try { parts = url.pathname.slice(basePath.length + 1).split("/").map((part) => decodeURIComponent(part)); }
  catch { throw invalid("path encodingが不正です"); }
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("/") || part.includes("\\"))) throw notFound();
  if (parts[0] !== "profiles" || !stableKeyPattern.test(parts[1] ?? "")) throw notFound();
  const profileId = parts[1]!;
  if (parts.length === 3 && parts[2] === "participants" && request.method === "POST") {
    return { operation: "createFeedbackParticipant", permission: "feedback:read", kind: "participant", profileId };
  }
  if (parts.length === 2 && request.method === "GET") return { operation: "getFeedbackProfile", permission: "feedback:read", kind: "profile", profileId };
  if (parts.length === 3 && parts[2] === "workspaces" && request.method === "GET") return { operation: "listFeedbackWorkspaces", permission: "feedback:read", kind: "workspaces", profileId };
  if (parts[2] !== "workspaces" || !stableKeyPattern.test(parts[3] ?? "")) throw notFound();
  const workspaceId = parts[3]!;
  if (parts.length === 5 && parts[4] === "resources" && request.method === "GET") return { operation: "listFeedbackResources", permission: "feedback:read", kind: "resources", profileId, workspaceId };
  if (parts[4] !== "threads") {
    if (parts.length === 6 && parts[4] === "intents" && uuidPattern.test(parts[5] ?? "") && request.method === "GET") {
      const operation = new URL(request.url).searchParams.get("operation");
      return { operation: "recoverFeedbackIntent", permission: parseRecoverableOperation(operation ?? ""), kind: "intent", profileId, workspaceId, intentId: parts[5] };
    }
    throw notFound();
  }
  if (parts.length === 5 && (request.method === "GET" || request.method === "POST")) return { operation: request.method === "GET" ? "listFeedbackThreads" : "createFeedbackThread", permission: request.method === "GET" ? "feedback:read" : "feedback:create", kind: "threads", profileId, workspaceId };
  if (!uuidPattern.test(parts[5] ?? "")) throw notFound();
  const threadId = parts[5]!;
  if (parts.length === 6 && request.method === "GET") return { operation: "getFeedbackThread", permission: "feedback:read", kind: "thread", profileId, workspaceId, threadId };
  if (parts.length === 7 && parts[6] === "messages" && request.method === "POST") return { operation: "replyFeedbackThread", permission: "feedback:reply", kind: "reply", profileId, workspaceId, threadId };
  if (parts.length === 9 && parts[6] === "messages" && uuidPattern.test(parts[7] ?? "") && parts[8] === "revisions" && request.method === "POST") return { operation: "appendFeedbackRevision", permission: "feedback:revise", kind: "revision", profileId, workspaceId, threadId, messageId: parts[7] };
  if (parts.length === 7 && parts[6] === "attachments" && request.method === "POST") return { operation: "uploadFeedbackAttachment", permission: "feedback:attachment:upload", kind: "upload", profileId, workspaceId, threadId };
  if (parts.length === 9 && parts[6] === "attachments" && uuidPattern.test(parts[7] ?? "") && parts[8] === "content" && request.method === "GET") return { operation: "getFeedbackAttachment", permission: "feedback:attachment:read", kind: "download", profileId, workspaceId, threadId, attachmentId: parts[7] };
  throw notFound();
}

function allowedQuery(route: Route, method: string): readonly string[] {
  if (route.kind === "participant") return [];
  if (route.kind === "profile") return ["workspaceId", "resourceKind", "resourceKey"];
  if (route.kind === "workspaces") return ["cursor"];
  if (route.kind === "resources") return ["query", "cursor"];
  if (route.kind === "threads" && method === "GET") return ["resourceKind", "resourceKey", "order", "cursor"];
  if (route.kind === "threads") return [];
  if (["thread", "reply", "revision", "upload", "download"].includes(route.kind)) return ["resourceKind", "resourceKey"];
  if (route.kind === "intent") return ["threadId", "operation", "resourceKind", "resourceKey"];
  return [];
}

function strictQuery(parameters: URLSearchParams, allowed: readonly string[]): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  const set = new Set(allowed);
  for (const [key, value] of parameters) {
    if (!set.has(key) || result[key] !== undefined || value.length === 0 || value.length > 2048) throw invalid("query parameterが不正です");
    result[key] = value;
  }
  return result;
}

function targetFor(
  route: Route,
  query: Record<string, string | undefined>,
  createResource?: FeedbackResourceRefV2
): FeedbackAuthorizationTarget {
  if (route.kind === "workspaces") return { level: "profile", profileId: route.profileId };
  if (route.kind === "resources") return { level: "workspace", profileId: route.profileId, workspaceId: route.workspaceId! };
  return {
    level: "resource",
    profileId: route.profileId,
    workspaceId: route.workspaceId ?? requiredString(query.workspaceId, "workspaceId"),
    resource: createResource ?? validateResource({ kind: requiredString(query.resourceKind, "resourceKind"), key: boundedString(query.resourceKey, "resourceKey", 1, 512) })
  };
}

async function readJson(request: Request, maximumBytes: number): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new FeedbackGatewayProblem({ code: "feedback.unsupported_media_type", status: 415, message: "application/jsonが必要です" });
  }
  const bytes = await boundedBody(request, maximumBytes);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw invalid("JSON requestが不正です"); }
}

async function readUpload(request: Request, maximumBytes: number): Promise<{
  command: FeedbackUploadAttachmentCommandV2;
  source: FeedbackUploadStreamSource;
}> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "multipart/form-data") {
    throw new FeedbackGatewayProblem({ code: "feedback.unsupported_media_type", status: 415, message: "multipart/form-dataが必要です" });
  }
  const contentType = request.headers.get("content-type")!;
  const bytes = await boundedBody(request, maximumBytes);
  let form: FormData;
  try {
    const body = bytes.slice().buffer;
    form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch { throw invalid("multipart requestが不正です"); }
  const commandPart = form.get("command");
  const filePart = form.get("file");
  if (typeof commandPart !== "string" || !(filePart instanceof File) || [...form.keys()].some((key) => key !== "command" && key !== "file")) {
    throw invalid("multipart fieldが不正です");
  }
  if (filePart.size > maximumBytes || commandPart.length > 262_144) throw tooLarge();
  let commandValue: unknown;
  try { commandValue = JSON.parse(commandPart); } catch { throw invalid("attachment command JSONが不正です"); }
  const command = validateUploadCommand(commandValue);
  if (command.filename !== filePart.name || command.contentType !== filePart.type || command.sizeBytes !== filePart.size) {
    throw invalid("attachment commandとfile metadataが一致しません");
  }
  return {
    command,
    source: {
      sizeBytes: filePart.size,
      async *read() {
        const reader = filePart.stream().getReader();
        try {
          while (true) {
            const item = await reader.read();
            if (item.done) return;
            yield item.value;
          }
        } finally {
          reader.releaseLock();
        }
      }
    }
  };
}

async function boundedBody(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) throw invalid("Content-Lengthが不正です");
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > maximumBytes) throw tooLarge();
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(Uint8Array.from(item.value));
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function validateCreateCommand(value: unknown): FeedbackCreateThreadCommandV2 {
  const command = exactObject(value, ["intentId", "requestHash", "threadId", "resource", "title", "body"]);
  requiredUuid(command.intentId, "intentId");
  requiredHash(command.requestHash, "requestHash");
  requiredUuid(command.threadId, "threadId");
  validateResource(command.resource);
  boundedString(command.title, "title", 1, 300);
  boundedString(command.body, "body", 1, 100_000);
  return command as FeedbackCreateThreadCommandV2;
}

function validateReplyCommand(value: unknown): FeedbackReplyCommandV2 {
  const command = exactObject(value, ["intentId", "requestHash", "messageId", "body"]);
  requiredUuid(command.intentId, "intentId");
  requiredHash(command.requestHash, "requestHash");
  requiredUuid(command.messageId, "messageId");
  boundedString(command.body, "body", 1, 100_000);
  return command as FeedbackReplyCommandV2;
}

function validateRevisionCommand(value: unknown): FeedbackAppendRevisionCommandV2 {
  const command = exactObject(value, ["intentId", "requestHash", "revisionId", "body", "expectedRevisionId"]);
  requiredUuid(command.intentId, "intentId");
  requiredHash(command.requestHash, "requestHash");
  requiredUuid(command.revisionId, "revisionId");
  requiredUuid(command.expectedRevisionId, "expectedRevisionId");
  boundedString(command.body, "body", 1, 100_000);
  return command as FeedbackAppendRevisionCommandV2;
}

function validateUploadCommand(value: unknown): FeedbackUploadAttachmentCommandV2 {
  const command = exactObject(value, ["intentId", "requestHash", "attachmentId", "messageId", "filename", "contentType", "sizeBytes", "contentHash", "purpose"], true);
  requiredUuid(command.intentId, "intentId");
  requiredHash(command.requestHash, "requestHash");
  requiredUuid(command.attachmentId, "attachmentId");
  if (command.messageId !== undefined) requiredUuid(command.messageId, "messageId");
  boundedString(command.filename, "filename", 1, 255);
  boundedString(command.contentType, "contentType", 1, 200);
  if (!Number.isInteger(command.sizeBytes) || (command.sizeBytes as number) < 1) throw invalid("sizeBytesが不正です");
  requiredHash(command.contentHash, "contentHash");
  if (command.purpose !== "evidence" && command.purpose !== "conversation") throw invalid("attachment purposeが不正です");
  return command as FeedbackUploadAttachmentCommandV2;
}

function validateParticipantRequest(value: unknown): { browserProfileId: string } {
  const request = exactObject(value, ["browserProfileId"]);
  return { browserProfileId: requiredUuid(request.browserProfileId, "browserProfileId") };
}

function exactObject(value: unknown, keys: readonly string[], optional = false): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("commandがobjectではありません");
  const object = value as Record<string, unknown>;
  const allowed = new Set(keys);
  if (Object.keys(object).some((key) => !allowed.has(key)) || (!optional && keys.some((key) => !(key in object)))) throw invalid("command fieldが不正です");
  const required = optional ? keys.filter((key) => key !== "messageId") : keys;
  if (required.some((key) => !(key in object))) throw invalid("commandの必須fieldがありません");
  return object;
}

function validateResource(value: unknown): FeedbackResourceRefV2 {
  const resource = exactObject(value, ["kind", "key"]);
  boundedString(resource.kind, "resource kind", 1, 128);
  if (!stableKeyPattern.test(resource.kind as string)) throw invalid("resource kindが不正です");
  boundedString(resource.key, "resource key", 1, 512);
  return resource as FeedbackResourceRefV2;
}

function requiredString(value: unknown, name: string): string {
  return boundedString(value, name, 1, 500);
}

function boundedString(value: unknown, name: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) throw invalid(`${name}が不正です`);
  return value;
}

function requiredUuid(value: unknown, name: string): string {
  const text = boundedString(value, name, 1, 64);
  if (!uuidPattern.test(text)) throw invalid(`${name}がUUIDではありません`);
  return text;
}

function requiredHash(value: unknown, name: string): string {
  const text = boundedString(value, name, 1, 100);
  if (!requestHashPattern.test(text)) throw invalid(`${name}が不正です`);
  return text;
}

function parseRecoverableOperation(value: string): Exclude<FeedbackOperationV2, "feedback:read" | "feedback:attachment:read"> {
  if (value === "feedback:create" || value === "feedback:reply" || value === "feedback:revise" || value === "feedback:attachment:upload") return value;
  throw invalid("回収対象operationが不正です");
}

function parseOrder(value: string | undefined): "updated_desc" | "updated_asc" | undefined {
  if (value === undefined || value === "updated_desc" || value === "updated_asc") return value;
  throw invalid("orderが不正です");
}

function commandStatus(result: object): number {
  if ("state" in result) return 202;
  return "disposition" in result && result.disposition === "created" ? 201 : 200;
}

function bearerToken(header: string | null): string | undefined {
  if (header === null) return undefined;
  const match = header.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u);
  if (!match) throw new FeedbackGatewayProblem({ code: "feedback.unauthorized", status: 401, message: "Authorization headerが不正です" });
  return match[1];
}

function validateOrigin(request: Request, expectedOrigin: string): void {
  const url = new URL(request.url);
  if (url.origin !== expectedOrigin) throw new FeedbackGatewayProblem({ code: "feedback.forbidden", status: 403, message: "request originが配備originと一致しません" });
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== expectedOrigin) throw new FeedbackGatewayProblem({ code: "feedback.forbidden", status: 403, message: "Originが一致しません" });
  const unsafe = !new Set(["GET", "HEAD", "OPTIONS"]).has(request.method);
  if (unsafe && (origin !== expectedOrigin || request.headers.get("x-feedback-csrf") !== "1")) {
    throw new FeedbackGatewayProblem({ code: "feedback.forbidden", status: 403, message: "same-origin CSRF検証に失敗しました" });
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") throw new FeedbackGatewayProblem({ code: "feedback.forbidden", status: 403, message: "cross-site requestは許可されていません" });
}

function normalizeExpectedOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.origin !== origin || !new Set(["https:", "http:"]).has(url.protocol) || url.username || url.password) throw new Error("expectedOriginが不正です");
  return url.origin;
}

function normalizeBasePath(value: string): string {
  if (!/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/u.test(value)) throw new Error("basePathが不正です");
  return value;
}

function createDeadlineSignal(nativeSignal: AbortSignal, timeoutMilliseconds: number) {
  let aborted = nativeSignal.aborted;
  let timedOut = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    if (aborted) return;
    aborted = true;
    for (const listener of listeners) listener();
  };
  const nativeAbort = () => notify();
  nativeSignal.addEventListener("abort", nativeAbort, { once: true });
  let expire!: () => void;
  const expiration = new Promise<never>((_resolve, reject) => {
    expire = () => reject(new FeedbackGatewayProblem({
      code: "feedback.provider_timeout",
      status: 504,
      retryable: true,
      message: "operationがtimeoutしました"
    }));
  });
  const timer = setTimeout(() => {
    timedOut = true;
    notify();
    expire();
  }, timeoutMilliseconds);
  const signal: FeedbackAbortSignal = {
    get aborted() { return aborted; },
    subscribe(listener) {
      if (aborted) { listener(); return () => undefined; }
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
  return {
    signal,
    expiration,
    timedOut: () => timedOut,
    dispose() { clearTimeout(timer); nativeSignal.removeEventListener("abort", nativeAbort); listeners.clear(); }
  };
}

function asyncIterableBody(body: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() { await iterator.return?.(); }
  });
}

function contentDisposition(filename: string): string {
  const safe = filename.replace(/[^\x20-\x7e]|["\\]/gu, "_");
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function secureResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function problemResponse(problem: FeedbackGatewayProblem, traceId: string): Response {
  return secureResponse(new Response(JSON.stringify({
    type: `urn:geibee:feedback:problem:${problem.code}`,
    title: problem.code,
    status: problem.status,
    code: problem.code,
    detail: problem.message,
    traceId,
    retryable: problem.retryable,
    ...(problem.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: problem.retryAfterSeconds })
  }), {
    status: problem.status,
    headers: { "content-type": "application/problem+json; charset=utf-8" }
  }));
}

function normalizeProblem(error: unknown): FeedbackGatewayProblem {
  if (error instanceof FeedbackGatewayProblem) return error;
  if (error instanceof FeedbackConnectorProblem) {
    const code = canonicalConnectorCode(error.code, error.status);
    return new FeedbackGatewayProblem({
      code,
      status: error.status,
      retryable: error.retryable,
      retryAfterSeconds: error.retryAfterSeconds,
      message: "provider operationに失敗しました"
    });
  }
  const structural = structuralConnectorProblem(error);
  if (structural) return structural;
  return new FeedbackGatewayProblem({ code: "feedback.provider_unavailable", status: 502, retryable: true, message: "Feedback providerを利用できません" });
}

function canonicalConnectorCode(
  code: FeedbackConnectorProblem["code"],
  status: number
): FeedbackGatewayProblem["code"] {
  // v1 Connector portの狭いcode集合を維持したまま、凍結v2 wireへstatus単位で正規化する。
  if (status === 400 && code === "feedback.conflict") return "feedback.cursor_invalid";
  if (status === 404 && code === "feedback.conflict") return "feedback.not_found";
  if (status === 413 && code === "feedback.unsupported") return "feedback.payload_too_large";
  if (status === 415 && code === "feedback.unsupported") return "feedback.unsupported_media_type";
  return code;
}

function structuralConnectorProblem(error: unknown): FeedbackGatewayProblem | null {
  if (typeof error !== "object" || error === null || Array.isArray(error)) return null;
  const candidate = error as Record<string, unknown>;
  const statuses: Readonly<Record<string, number>> = {
    "feedback.forbidden": 403,
    "feedback.not_found": 404,
    "feedback.conflict": 409,
    "feedback.cursor_invalid": 400,
    "feedback.integrity_error": 409,
    "feedback.payload_too_large": 413,
    "feedback.unsupported_media_type": 415,
    "feedback.rate_limited": 429,
    "feedback.provider_unavailable": 502,
    "feedback.provider_timeout": 504,
    "feedback.unsupported": 422
  };
  if (typeof candidate.code !== "string" || statuses[candidate.code] === undefined ||
      typeof candidate.retryable !== "boolean") return null;
  const retryAfterSeconds = candidate.retryAfterSeconds;
  if (retryAfterSeconds !== undefined && (!Number.isInteger(retryAfterSeconds) || (retryAfterSeconds as number) < 0)) return null;
  return new FeedbackGatewayProblem({
    code: candidate.code as FeedbackGatewayProblem["code"],
    status: statuses[candidate.code]!,
    retryable: candidate.retryable,
    retryAfterSeconds: retryAfterSeconds as number | undefined,
    message: "provider operationに失敗しました"
  });
}

function invalid(message: string): FeedbackGatewayProblem {
  return new FeedbackGatewayProblem({ code: "feedback.invalid_request", status: 400, message });
}

function tooLarge(): FeedbackGatewayProblem {
  return new FeedbackGatewayProblem({ code: "feedback.payload_too_large", status: 413, message: "request bodyが上限を超えています" });
}

function notFound(): FeedbackGatewayProblem {
  return new FeedbackGatewayProblem({ code: "feedback.not_found", status: 404, message: "routeが見つかりません" });
}

function sameResource(left: FeedbackResourceRefV2, right: FeedbackResourceRefV2): boolean {
  return left.kind === right.kind && left.key === right.key;
}
