import {
  decodeListCursor,
  encodeListCursor,
  RedmineFeedbackError,
  type FeedbackHostResourceRefV1
} from "@feedback/redmine-core";
import {
  validateConnectorProfile
} from "@feedback/redmine-core/trusted";
import {
  requireProfileAuthorization,
  requireResourceAuthorization,
  requireStoredResourceAuthorization
} from "./authorization.js";
import { validateCsrf, validateSameOriginRequest } from "./csrf.js";
import { readCreateMultipart } from "./multipart.js";
import { GatewayHttpError, jsonResponse, problemResponse } from "./problem.js";
import type { GatewayDependencies, GatewayServerProfile } from "./profile.js";
import { loadGatewayRedmineClient } from "./redmine.js";
import {
  assertEvidencePart,
  parseCreateRequest,
  parseListQuery,
  parseResourceQuery
} from "./validation.js";

type Route = {
  operation: string;
  profileId: string;
  kind: "profile" | "me" | "list" | "create" | "detail" | "attachment";
  threadId?: string;
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
      if ((route.kind === "profile" || route.kind === "me" || route.kind === "create") && routeUrl.search) {
        throw new GatewayHttpError(400, "redmine.contract_invalid", "unknown query parameterがあります");
      }
      const principal = await dependencies.host.authenticate(request);
      if (!principal) throw new GatewayHttpError(401, "redmine.unauthenticated", "業務アプリケーションの認証が必要です");
      validatePrincipal(principal);
      const profile = await loadProfile(dependencies, route.profileId);
      const profileOperation = route.kind === "create" ? "create" : "read";
      await requireProfileAuthorization(dependencies.host, principal, route.profileId, profileOperation);
      if (route.kind === "profile") {
        const canCreate = await dependencies.host.authorizeProfile({ principal, operation: "create", profileId: route.profileId });
        const responseProfile = { ...profile.clientProfile, showRedmineLink: profile.showRedmineLink };
        const response = jsonResponse({
          profile: responseProfile,
          capabilities: { canRead: true, canCreate, repliesReadOnly: true, stateReadOnly: true }
        });
        status = response.status;
        return response;
      }
      const client = await loadGatewayRedmineClient(dependencies, profile);
      if (route.kind === "me") {
        await client.validateConnection(request.signal);
        const response = jsonResponse({
          principal: {
            subjectId: principal.subjectId,
            displayName: principal.displayName,
            redmineUserId: principal.redmineUserId,
            source: "host-session"
          }
        });
        status = response.status;
        return response;
      }
      const url = routeUrl;
      if (route.kind === "list") {
        const input = parseListQuery(url.searchParams);
        const resourceKey = await requireResourceAuthorization(
          dependencies.host, principal, route.profileId, "list", input.resourceRef
        );
        const cursorInput = {
          v: "1" as const,
          profileId: route.profileId,
          hostResourceKey: resourceKey,
          pageKey: input.pageKey,
          filter: input.filter,
          sort: input.sort
        };
        const offset = input.cursor ? decodeListCursor(input.cursor, cursorInput).offset : 0;
        const result = await client.listThreads({
          hostResourceKey: resourceKey,
          pageKey: input.pageKey,
          sort: input.sort,
          filter: input.filter,
          offset
        }, request.signal);
        const response = jsonResponse({
          threads: result.threads,
          nextCursor: result.nextOffset !== null
            ? encodeListCursor({ ...cursorInput, offset: result.nextOffset })
            : null
        });
        status = response.status;
        return response;
      }
      if (route.kind === "create") {
        await validateCsrf(request, principal, dependencies.host);
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
        const resourceKey = await requireResourceAuthorization(
          dependencies.host, principal, route.profileId, "create", input.resourceRef
        );
        const created = await client.createThreadWithDisposition({
          ...input,
          hostResourceKey: resourceKey,
          author: {
            source: "host-session",
            subjectId: principal.subjectId,
            displayName: principal.displayName,
            redmineUserId: principal.redmineUserId
          }
        }, multipart.evidence?.bytes ?? null, request.signal);
        const response = jsonResponse(
          { thread: created.thread },
          created.disposition === "created" ? 201 : 200
        );
        status = response.status;
        return response;
      }
      const resourceRef = parseResourceQuery(url.searchParams, []);
      assertIgnoredClientResource(resourceRef);
      const lookup = await client.lookupThreadAuthorization(route.threadId!, request.signal);
      await requireStoredResourceAuthorization(
        dependencies.host,
        principal,
        route.profileId,
        route.kind === "attachment" ? "attachment" : "detail",
        lookup.hostResourceKey
      );
      if (route.kind === "detail") {
        const thread = await client.getThread({ hostResourceKey: lookup.hostResourceKey, threadId: route.threadId! }, request.signal);
        const response = jsonResponse({ thread });
        status = response.status;
        return response;
      }
      const content = await client.getAttachment({
        hostResourceKey: lookup.hostResourceKey,
        threadId: route.threadId!,
        attachmentId: route.attachmentId!
      }, request.signal);
      const response = new Response(Uint8Array.from(content.bytes).buffer, {
        headers: {
          "Content-Type": content.contentType,
          "Content-Disposition": contentDisposition(content.filename),
          "X-Feedback-Content-SHA256": content.sha256,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        }
      });
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

function validatePrincipal(principal: { subjectId: string; displayName: string | null; redmineUserId: number | null }): void {
  if (!principal.subjectId || principal.subjectId.length > 200 ||
    (principal.displayName !== null && (!principal.displayName || principal.displayName.length > 200)) ||
    (principal.redmineUserId !== null && (!Number.isInteger(principal.redmineUserId) || principal.redmineUserId < 1))) {
    throw new GatewayHttpError(500, "redmine.unavailable", "host principalが不正です");
  }
}

function assertIgnoredClientResource(_resourceRef: FeedbackHostResourceRefV1): void {
  // detail/attachmentの認可は保存済みopaque resource keyだけで行う。
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
