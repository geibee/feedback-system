import {
  decodeListCursor,
  encodeListCursor,
  RedmineFeedbackError
} from "@feedback/redmine-core";
import {
  validateConnectorProfile
} from "@feedback/redmine-core/trusted";
import { validateSameOriginRequest } from "./csrf.js";
import { readCreateMultipart } from "./multipart.js";
import { GatewayHttpError, jsonResponse, problemResponse } from "./problem.js";
import type { GatewayDependencies, GatewayServerProfile } from "./profile.js";
import {
  issueParticipantCredential,
  requireParticipantCredential,
  signMessageMarker,
  verifyMessageMarker
} from "./participant.js";
import { loadGatewayRedmineClient } from "./redmine.js";
import {
  assertEvidencePart,
  parseCreateMessageRequest,
  parseCreateParticipantRequest,
  parseCreateRequest,
  parseListQuery,
  parseResourceQuery,
  parseUpdateMessageRequest
} from "./validation.js";

type Route = {
  operation: string;
  profileId: string;
  kind: "participant" | "profile" | "me" | "list" | "create" | "detail" | "reply" | "edit" | "attachment";
  threadId?: string;
  messageId?: string;
  attachmentId?: number;
};

export function createFeedbackRedmineGatewayHandler(dependencies: GatewayDependencies) {
  const basePath = normalizeBasePath(dependencies.basePath ?? "/internal/feedback-redmine/v1");
  return async (request: Request): Promise<Response> => {
    const requestId = crypto.randomUUID();
    const started = performance.now();
    let route: Route | null = null;
    let status = 500;
    try {
      route = parseRoute(request, basePath);
      validateSameOriginRequest(request);
      const routeUrl = new URL(request.url);
      if (["participant", "profile", "me", "create", "reply", "edit"].includes(route.kind) && routeUrl.search) {
        throw new GatewayHttpError(400, "redmine.contract_invalid", "unknown query parameterがあります");
      }
      const response = await handlePublicRoute(request, route, dependencies);
      status = response.status;
      return response;
    } catch (error) {
      const response = problemResponse(error, requestId);
      status = response.status;
      return response;
    } finally {
      if (route) {
        try {
          dependencies.metric?.({
            operation: route.operation,
            profileId: route.profileId,
            status,
            durationMilliseconds: performance.now() - started
          });
        } catch {
          // metric sinkの失敗でgateway responseを変えない。
        }
      }
    }
  };
}

async function handlePublicRoute(
  request: Request,
  route: Route,
  dependencies: GatewayDependencies
): Promise<Response> {
  const signingKey = dependencies.participantSigningKey;
  const profile = await loadProfile(dependencies, route.profileId);
  const requestOrigin = new URL(request.url).origin;
  if (route.kind === "participant") {
    const input = parseCreateParticipantRequest(await readJson(request));
    const participant = await issueParticipantCredential({
      browserProfileId: input.browserProfileId,
      profileId: route.profileId,
      origin: requestOrigin,
      signingKey
    });
    return jsonResponse(participant, 201);
  }
  if (route.kind === "profile") {
    return jsonResponse({
      profile: { ...profile.clientProfile, showRedmineLink: profile.showRedmineLink },
      capabilities: { canRead: true, canCreate: true, canReply: true, canEditOwn: true, stateReadOnly: true }
    });
  }
  const participantRequired = route.kind === "me" || route.kind === "create" || route.kind === "reply" || route.kind === "edit";
  const participant = participantRequired || request.headers.has("X-Feedback-Participant-Credential")
    ? await requireParticipantCredential({ request, profileId: route.profileId, signingKey })
    : null;
  if (route.kind === "me") {
    return jsonResponse({
      principal: { participantId: participant!.participantId, displayName: null, source: "participant-credential" }
    });
  }
  const client = await loadGatewayRedmineClient(dependencies, profile);
  const url = new URL(request.url);
  if (route.kind === "list") {
    const input = parseListQuery(url.searchParams);
    if (input.scope === "workspace") {
      const cursorInput = {
        v: "2" as const,
        scope: "workspace" as const,
        profileId: route.profileId,
        filter: input.filter,
        sort: input.sort
      };
      const offset = input.cursor ? decodeListCursor(input.cursor, cursorInput).offset : 0;
      const result = await client.listThreads({
        scope: "workspace",
        sort: input.sort,
        filter: input.filter,
        offset
      }, request.signal);
      return jsonResponse({
        threads: result.threads,
        totalCount: result.totalCount,
        nextCursor: result.nextOffset !== null ? encodeListCursor({ ...cursorInput, offset: result.nextOffset }) : null
      });
    }
    const cursorInput = {
        v: "1" as const,
        profileId: route.profileId,
        hostResourceKey: publicResourceKey(input.resourceRef.key),
        pageKey: input.pageKey,
        filter: input.filter,
        sort: input.sort
    };
    const offset = input.cursor ? decodeListCursor(input.cursor, cursorInput).offset : 0;
    const result = await client.listThreads({
      hostResourceKey: cursorInput.hostResourceKey,
      pageKey: input.pageKey,
      sort: input.sort,
      filter: input.filter,
      offset
    }, request.signal);
    return jsonResponse({
      threads: result.threads,
      totalCount: result.totalCount,
      nextCursor: result.nextOffset !== null ? encodeListCursor({ ...cursorInput, offset: result.nextOffset }) : null
    });
  }
  if (route.kind === "create") {
    const maximum = Math.min(
      dependencies.maximumRequestBytes ?? profile.clientProfile.capture.maximumUploadBytes + 262_144,
      profile.clientProfile.capture.maximumUploadBytes + 262_144
    );
    const multipart = await readCreateMultipart(request, maximum);
    const input = parseCreateRequest(multipart.request, route.profileId);
    assertEvidencePart(input.evidence, multipart.evidence);
    if (request.headers.get("Idempotency-Key") !== input.intentId) {
      throw new GatewayHttpError(400, "redmine.contract_invalid", "Idempotency-Keyとintent IDが一致しません");
    }
    const markerSignature = await signMessageMarker({
      signingKey,
      profileId: route.profileId,
      threadId: input.threadId,
      messageId: input.threadId,
      participantId: participant!.participantId,
      kind: "initial",
      version: 1,
      intentId: input.intentId,
      body: input.comment
    });
    const created = await client.createThreadWithDisposition({
      ...input,
      hostResourceKey: publicResourceKey(input.resourceRef.key),
      markerSignature,
      author: {
        source: "participant-credential",
        participantId: participant!.participantId,
        displayName: input.participantName ?? null
      }
    }, multipart.evidence?.bytes ?? null, request.signal);
    return jsonResponse({ thread: created.thread }, created.disposition === "created" ? 201 : 200);
  }
  const lookup = await client.lookupThreadAuthorization(route.threadId!, request.signal);
  if (route.kind === "detail" || route.kind === "attachment") {
    const resource = parseResourceQuery(url.searchParams, []);
    if (publicResourceKey(resource.key) !== lookup.hostResourceKey) {
      throw new GatewayHttpError(404, "redmine.not_found", "threadが見つかりません");
    }
  } else if (url.search) {
    throw new GatewayHttpError(400, "redmine.contract_invalid", "unknown query parameterがあります");
  }
  if (route.kind === "detail") {
    const thread = await client.getThread(
      { hostResourceKey: lookup.hostResourceKey, threadId: route.threadId! },
      request.signal,
      participant?.participantId ?? null
    );
    return jsonResponse({ thread });
  }
  if (route.kind === "reply") {
    const intentId = requiredIdempotencyKey(request);
    const input = parseCreateMessageRequest(await readJson(request), route.profileId, route.threadId!, intentId);
    const markerSignature = await signMessageMarker({
      signingKey,
      profileId: route.profileId,
      threadId: route.threadId!,
      messageId: input.messageId,
      participantId: participant!.participantId,
      kind: "reply",
      version: 1,
      intentId,
      body: input.body
    });
    const result = await client.createMessageWithDisposition({
      ...input,
      hostResourceKey: lookup.hostResourceKey,
      markerSignature,
      author: {
        source: "participant-credential",
        participantId: participant!.participantId,
        displayName: input.participantName
      }
    }, request.signal);
    return jsonResponse({ thread: result.thread }, result.disposition === "created" ? 201 : 200);
  }
  if (route.kind === "edit") {
    const intentId = requiredIdempotencyKey(request);
    const input = parseUpdateMessageRequest(
      await readJson(request), route.profileId, route.threadId!, route.messageId!, intentId
    );
    const ownership = await client.lookupMessageOwnership({
      hostResourceKey: lookup.hostResourceKey,
      threadId: route.threadId!,
      messageId: route.messageId!
    }, request.signal);
    if (!ownership || ownership.participantId !== participant!.participantId || !await verifyMessageMarker({
      signingKey,
      profileId: route.profileId,
      threadId: route.threadId!,
      messageId: route.messageId!,
      participantId: ownership.participantId,
      kind: ownership.markerKind,
      version: ownership.version,
      intentId: ownership.intentId,
      body: ownership.body,
      signature: ownership.signature
    })) throw new GatewayHttpError(403, "redmine.permission_denied", "投稿の所有情報を確認できません");
    const markerSignature = await signMessageMarker({
      signingKey,
      profileId: route.profileId,
      threadId: route.threadId!,
      messageId: route.messageId!,
      participantId: participant!.participantId,
      kind: "edit",
      version: input.expectedVersion + 1,
      intentId,
      body: input.body
    });
    const thread = await client.updateMessage({
      ...input,
      hostResourceKey: lookup.hostResourceKey,
      markerSignature,
      author: {
        source: "participant-credential",
        participantId: participant!.participantId,
        displayName: input.participantName
      }
    }, request.signal);
    return jsonResponse({ thread });
  }
  const content = await client.getAttachment({
    hostResourceKey: lookup.hostResourceKey,
    threadId: route.threadId!,
    attachmentId: route.attachmentId!
  }, request.signal);
  return new Response(Uint8Array.from(content.bytes).buffer, {
    headers: {
      "Content-Type": content.contentType,
      "Content-Disposition": contentDisposition(content.filename),
      "X-Feedback-Content-SHA256": content.sha256,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new GatewayHttpError(400, "redmine.contract_invalid", "application/jsonが必要です");
  }
  try {
    return await request.json();
  } catch {
    throw new GatewayHttpError(400, "redmine.contract_invalid", "JSON requestが不正です");
  }
}

function publicResourceKey(value: string): string {
  if (!value || value.length > 200) throw new GatewayHttpError(400, "redmine.contract_invalid", "resource keyが不正です");
  return value;
}

function requiredIdempotencyKey(request: Request): string {
  const value = request.headers.get("Idempotency-Key") ?? "";
  if (!uuidPattern.test(value)) throw new GatewayHttpError(400, "redmine.contract_invalid", "Idempotency-KeyがUUIDではありません");
  return value;
}

function parseRoute(request: Request, basePath: string): Route {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${basePath}/`)) throw new GatewayHttpError(404, "redmine.not_found", "routeが見つかりません");
  let parts: string[];
  try {
    parts = url.pathname.slice(basePath.length + 1).split("/").map((part) => decodeURIComponent(part));
  } catch {
    throw new GatewayHttpError(404, "redmine.not_found", "routeが見つかりません");
  }
  if (parts[0] !== "profiles" || !/^[a-z0-9][a-z0-9._-]{0,99}$/u.test(parts[1] ?? "")) {
    throw new GatewayHttpError(404, "redmine.not_found", "routeが見つかりません");
  }
  const profileId = parts[1]!;
  if (request.method === "POST" && parts.length === 3 && parts[2] === "participants") {
    return { operation: "redmine.participant.create.v1", profileId, kind: "participant" };
  }
  if (request.method === "GET" && parts.length === 2) return { operation: "redmine.profile.get.v1", profileId, kind: "profile" };
  if (request.method === "GET" && parts.length === 3 && parts[2] === "me") {
    return { operation: "redmine.current-user.get.v1", profileId, kind: "me" };
  }
  if (parts[2] === "threads" && parts.length === 3) {
    if (request.method === "GET") return { operation: "redmine.thread.list.v1", profileId, kind: "list" };
    if (request.method === "POST") return { operation: "redmine.thread.create.v1", profileId, kind: "create" };
  }
  if (request.method === "GET" && parts[2] === "threads" && uuidPattern.test(parts[3] ?? "")) {
    if (parts.length === 4) {
      return { operation: "redmine.thread.get.v1", profileId, kind: "detail", threadId: parts[3] };
    }
    if (parts.length === 6 && parts[4] === "attachments" && /^[1-9][0-9]*$/u.test(parts[5] ?? "")) {
      return {
        operation: "redmine.attachment.get.v1",
        profileId,
        kind: "attachment",
        threadId: parts[3],
        attachmentId: Number(parts[5])
      };
    }
  }
  if (parts[2] === "threads" && uuidPattern.test(parts[3] ?? "")) {
    if (request.method === "POST" && parts.length === 5 && parts[4] === "messages") {
      return { operation: "redmine.message.create.v1", profileId, kind: "reply", threadId: parts[3] };
    }
    if (request.method === "PATCH" && parts.length === 6 && parts[4] === "messages" && uuidPattern.test(parts[5] ?? "")) {
      return {
        operation: "redmine.message.update.v1",
        profileId,
        kind: "edit",
        threadId: parts[3],
        messageId: parts[5]
      };
    }
  }
  throw new GatewayHttpError(404, "redmine.not_found", "routeが見つかりません");
}

async function loadProfile(dependencies: GatewayDependencies, profileId: string): Promise<GatewayServerProfile> {
  const profile = await dependencies.loadProfile(profileId);
  if (!profile || profile.authorizationMode !== "resource-scoped" || !profile.secretRef) {
    throw new GatewayHttpError(404, "redmine.not_found", "profileが見つかりません");
  }
  try {
    return {
      ...validateConnectorProfile(profile, { allowHttpDevelopment: dependencies.allowHttpDevelopment ?? false }),
      authorizationMode: "resource-scoped",
      secretRef: profile.secretRef
    };
  } catch {
    throw new GatewayHttpError(503, "redmine.unavailable", "gateway profile設定が不正です");
  }
}

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 120) || "attachment";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function normalizeBasePath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || /[\\?#]/u.test(value)) throw new Error("gateway base pathが不正です");
  return value.replace(/\/+$/u, "");
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
