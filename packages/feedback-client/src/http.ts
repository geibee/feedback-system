import type {
  FeedbackAttachmentCommandResultV2,
  FeedbackIntentRecoveryResultV2,
  FeedbackMessageCommandResultV2,
  FeedbackOperationV2,
  FeedbackProblemV2,
  FeedbackProfileV2,
  FeedbackResourceRefV2,
  FeedbackResourcePageV2,
  FeedbackThreadCommandResultV2,
  FeedbackThreadPageV2,
  FeedbackThreadV2,
  FeedbackUploadAttachmentCommandV2,
  FeedbackWorkspacePageV2
} from "@geibee/feedback-contracts/v2";
import {
  FeedbackClientProblem,
  type FeedbackAbortSignal,
  type FeedbackClientPort,
  type FeedbackDownloadResult,
  type FeedbackIntentRecoveryResultFor,
  type FeedbackRequestOptions,
  type FeedbackUploadSource
} from "./index.js";

export type FeedbackHttpRequestBody = string | AsyncIterable<Uint8Array>;

export type FeedbackHttpRequest = {
  method: "GET" | "POST";
  path: string;
  headers: Readonly<Record<string, string>>;
  body?: FeedbackHttpRequestBody;
  signal?: FeedbackAbortSignal;
};

export interface FeedbackHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  json(): Promise<unknown>;
  readonly body?: AsyncIterable<Uint8Array>;
  dispose?(): void | Promise<void>;
}

export interface FeedbackHttpTransport {
  request(request: FeedbackHttpRequest): Promise<FeedbackHttpResponse>;
}

export interface FeedbackFetchHeaders {
  get(name: string): string | null;
  forEach?(callback: (value: string, name: string) => void): void;
}

export interface FeedbackFetchBodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel?(): Promise<void>;
}

export interface FeedbackFetchResponse {
  readonly status: number;
  readonly headers: FeedbackFetchHeaders;
  readonly body: null | { getReader(): FeedbackFetchBodyReader };
  json(): Promise<unknown>;
}

export interface FeedbackFetch {
  (input: string, init: {
    method: string;
    headers: Readonly<Record<string, string>>;
    body?: unknown;
    credentials: "same-origin";
    cache: "no-store";
    signal?: unknown;
    duplex?: "half";
  }): Promise<FeedbackFetchResponse>;
}

type AbortControllerLike = {
  readonly signal: unknown;
  abort(): void;
};

type ReadableStreamControllerLike = {
  enqueue(chunk: Uint8Array): void;
  close(): void;
  error(reason: unknown): void;
};

type BrowserPrimitives = {
  AbortController?: new () => AbortControllerLike;
  ReadableStream?: new (source: {
    pull(controller: ReadableStreamControllerLike): Promise<void>;
    cancel(): Promise<void>;
  }) => unknown;
};

/** Web標準fetchを同一origin限定のtransportへ適合する。 */
export function createFetchFeedbackTransport(fetch: FeedbackFetch): FeedbackHttpTransport {
  return {
    async request(request) {
      const primitives = globalThis as unknown as BrowserPrimitives;
      const abortController = primitives.AbortController ? new primitives.AbortController() : undefined;
      const unsubscribe = request.signal?.subscribe(() => abortController?.abort());
      if (request.signal?.aborted) abortController?.abort();
      let body: unknown = request.body;
      let duplex: "half" | undefined;
      if (request.body !== undefined && typeof request.body !== "string") {
        if (!primitives.ReadableStream) throw new Error("request streamingを利用できません");
        const iterator = request.body[Symbol.asyncIterator]();
        body = new primitives.ReadableStream({
          async pull(controller) {
            try {
              const result = await iterator.next();
              if (result.done) controller.close();
              else controller.enqueue(result.value);
            } catch (error) {
              controller.error(error);
            }
          },
          async cancel() {
            await iterator.return?.();
          }
        });
        duplex = "half";
      }
      try {
        const response = await fetch(request.path, {
          method: request.method,
          headers: request.headers,
          ...(body === undefined ? {} : { body }),
          credentials: "same-origin",
          cache: "no-store",
          ...(abortController ? { signal: abortController.signal } : {}),
          ...(duplex ? { duplex } : {})
        });
        const headers: Record<string, string> = {};
        response.headers.forEach?.((value, name) => { headers[name.toLowerCase()] = value; });
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          unsubscribe?.();
        };
        const bodyStream = response.body === null ? undefined : lazyReaderToAsyncIterable(response.body, cleanup);
        if (response.body === null) cleanup();
        return {
          status: response.status,
          headers,
          async json() {
            try { return await response.json(); } finally { cleanup(); }
          },
          body: bodyStream,
          async dispose() {
            cleanup();
            if (response.body) await response.body.getReader().cancel?.();
          }
        };
      } catch (error) {
        unsubscribe?.();
        if (!request.signal?.aborted) {
          throw transportProblem(503, "Feedback Serviceへ接続できません");
        }
        throw error;
      }
    }
  };
}

export type FeedbackHttpClientOptions = {
  transport: FeedbackHttpTransport;
  basePath?: string;
  createMultipartBoundary?: () => string;
  credentialProvider?: FeedbackRequestCredentialProvider;
};

export type FeedbackRequestCredentialScope = {
  profileId: string;
  workspaceId?: string;
  resource?: FeedbackResourceRefV2;
  operation: FeedbackOperationV2;
};

export type FeedbackRequestCredentials = {
  bearerToken?: string;
  participantCredential?: string;
};

export type FeedbackRequestCredentialProvider = (
  scope: FeedbackRequestCredentialScope
) => FeedbackRequestCredentials | undefined | Promise<FeedbackRequestCredentials | undefined>;

/** frozen v2 wireをFeedbackClientPortへ写像する。HTTP retryは一切行わない。 */
export function createFeedbackHttpClient(options: FeedbackHttpClientOptions): FeedbackClientPort {
  const basePath = normalizeBasePath(options.basePath ?? "/internal/feedback/v2");
  let boundarySequence = 0;
  const boundary = options.createMultipartBoundary ?? (() => `feedback-v2-${++boundarySequence}`);
  const requestJson = async <T>(
    method: "GET" | "POST",
    path: string,
    requestOptions: FeedbackRequestOptions | undefined,
    body?: unknown,
    credentialScope?: FeedbackRequestCredentialScope,
    additionalHeaders: Readonly<Record<string, string>> = {}
  ): Promise<T> => {
    if (!credentialScope) throw new Error("credential scopeがありません");
    const credentialHeaders = await resolveCredentialHeaders(options.credentialProvider, credentialScope);
    const response = await options.transport.request({
      method,
      path: `${basePath}${path}`,
      headers: {
        Accept: "application/json, application/problem+json",
        ...(body === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" }),
        ...(method === "POST" ? { "X-Feedback-CSRF": "1" } : {}),
        ...additionalHeaders,
        ...credentialHeaders
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: requestOptions?.signal
    });
    return readJsonResponse<T>(response);
  };
  return {
    async issueParticipant(query, requestOptions) {
      const response = await options.transport.request({
        method: "POST",
        path: `${basePath}/profiles/${segment(query.profileId)}/participants`,
        headers: {
          Accept: "application/json, application/problem+json",
          "Content-Type": "application/json; charset=utf-8",
          "X-Feedback-CSRF": "1"
        },
        body: JSON.stringify({ browserProfileId: query.browserProfileId }),
        signal: requestOptions?.signal
      });
      return readJsonResponse(response);
    },
    async getProfile(query, requestOptions) {
      const result = await requestJson<{ profile: FeedbackProfileV2 }>(
        "GET",
        `/profiles/${segment(query.profileId)}${scopeQuery(query.workspaceId, query.resource)}`,
        requestOptions,
        undefined,
        credentialScope(query.profileId, query.workspaceId, query.resource, "feedback:read")
      );
      return result.profile;
    },
    listWorkspaces(query, requestOptions) {
      return requestJson<FeedbackWorkspacePageV2>(
        "GET",
        `/profiles/${segment(query.profileId)}/workspaces${queryString({ cursor: query.cursor })}`,
        requestOptions,
        undefined,
        credentialScope(query.profileId, undefined, undefined, "feedback:read")
      );
    },
    listResources(query, requestOptions) {
      return requestJson<FeedbackResourcePageV2>(
        "GET",
        `/profiles/${segment(query.profileId)}/workspaces/${segment(query.workspaceId)}/resources${queryString({ query: query.query, cursor: query.cursor })}`,
        requestOptions,
        undefined,
        credentialScope(query.profileId, query.workspaceId, undefined, "feedback:read")
      );
    },
    listThreads(query, requestOptions) {
      return requestJson<FeedbackThreadPageV2>(
        "GET",
        `/profiles/${segment(query.profileId)}/workspaces/${segment(query.workspaceId)}/threads${scopeQuery(undefined, query.resource, { order: query.order, cursor: query.cursor })}`,
        requestOptions,
        undefined,
        credentialScope(query.profileId, query.workspaceId, query.resource, "feedback:read")
      );
    },
    async getThread(query, requestOptions) {
      const result = await requestJson<{ thread: FeedbackThreadV2 }>(
        "GET",
        `/profiles/${segment(query.profileId)}/workspaces/${segment(query.workspaceId)}/threads/${segment(query.threadId)}${scopeQuery(undefined, query.resource)}`,
        requestOptions,
        undefined,
        credentialScope(query.profileId, query.workspaceId, query.resource, "feedback:read")
      );
      return result.thread;
    },
    createThread(query, requestOptions) {
      return requestJson<FeedbackThreadCommandResultV2 | FeedbackIntentRecoveryResultFor<"feedback:create">>(
        "POST",
        `/profiles/${segment(query.profileId)}/workspaces/${segment(query.workspaceId)}/threads`,
        requestOptions,
        query.command,
        credentialScope(query.profileId, query.workspaceId, query.command.resource, "feedback:create")
      );
    },
    reply(query, requestOptions) {
      return requestJson<FeedbackMessageCommandResultV2 | FeedbackIntentRecoveryResultFor<"feedback:reply">>(
        "POST",
        `/profiles/${segment(query.profileId)}/workspaces/${segment(query.workspaceId)}/threads/${segment(query.threadId)}/messages${scopeQuery(undefined, query.resource)}`,
        requestOptions,
        query.command,
        credentialScope(query.profileId, query.workspaceId, query.resource, "feedback:reply")
      );
    },
    appendRevision(query, requestOptions) {
      return requestJson<FeedbackMessageCommandResultV2 | FeedbackIntentRecoveryResultFor<"feedback:revise">>(
        "POST",
        `/profiles/${segment(query.profileId)}/workspaces/${segment(query.workspaceId)}/threads/${segment(query.threadId)}/messages/${segment(query.messageId)}/revisions${scopeQuery(undefined, query.resource)}`,
        requestOptions,
        query.command,
        credentialScope(query.profileId, query.workspaceId, query.resource, "feedback:revise")
      );
    },
    recoverIntent(query, requestOptions) {
      return requestJson<FeedbackIntentRecoveryResultV2>(
        "GET",
        `/profiles/${segment(query.profileId)}/workspaces/${segment(query.workspaceId)}/intents/${segment(query.intentId)}${scopeQuery(undefined, query.resource, { threadId: query.threadId, operation: query.operation })}`,
        requestOptions,
        undefined,
        credentialScope(query.profileId, query.workspaceId, query.resource, query.operation),
        { "X-Feedback-Request-Hash": query.requestHash }
      );
    },
    async uploadAttachment(query, requestOptions) {
      const multipartBoundary = validateBoundary(boundary());
      if (query.command.sizeBytes !== query.source.sizeBytes) throw new Error("upload sourceとcommandのbyte lengthが一致しません");
      if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(query.command.contentType)) {
        throw new Error("attachment content typeが不正です");
      }
      const body = multipartBody(multipartBoundary, query.command, query.source);
      const credentialHeaders = await resolveCredentialHeaders(
        options.credentialProvider,
        credentialScope(query.profileId, query.workspaceId, query.resource, "feedback:attachment:upload")
      );
      const response = await options.transport.request({
        method: "POST",
        path: `${basePath}/profiles/${segment(query.profileId)}/workspaces/${segment(query.workspaceId)}/threads/${segment(query.threadId)}/attachments${scopeQuery(undefined, query.resource)}`,
        headers: {
          Accept: "application/json, application/problem+json",
          "Content-Type": `multipart/form-data; boundary=${multipartBoundary}`,
          "X-Feedback-CSRF": "1",
          ...credentialHeaders
        },
        body,
        signal: requestOptions?.signal
      });
      return readJsonResponse<FeedbackAttachmentCommandResultV2 | FeedbackIntentRecoveryResultFor<"feedback:attachment:upload">>(response);
    },
    async getAttachment(query, requestOptions): Promise<FeedbackDownloadResult> {
      const credentialHeaders = await resolveCredentialHeaders(
        options.credentialProvider,
        credentialScope(query.profileId, query.workspaceId, query.resource, "feedback:attachment:read")
      );
      const response = await options.transport.request({
        method: "GET",
        path: `${basePath}/profiles/${segment(query.profileId)}/workspaces/${segment(query.workspaceId)}/threads/${segment(query.threadId)}/attachments/${segment(query.attachmentId)}/content${scopeQuery(undefined, query.resource)}`,
        headers: { Accept: "application/octet-stream", ...credentialHeaders },
        signal: requestOptions?.signal
      });
      if (response.status < 200 || response.status >= 300) await throwProblem(response);
      if (!response.body) {
        await response.dispose?.();
        throw transportProblem(response.status, "attachment response bodyがありません");
      }
      const sizeHeader = header(response.headers, "content-length");
      const sizeBytes = sizeHeader !== null && /^\d+$/u.test(sizeHeader) ? Number(sizeHeader) : Number.NaN;
      const filename = contentDispositionFilename(header(response.headers, "content-disposition"));
      const contentType = header(response.headers, "content-type")?.split(";", 1)[0]?.trim();
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !filename || !contentType) {
        await response.dispose?.();
        throw transportProblem(response.status, "attachment metadata headerが不正です");
      }
      return {
        filename,
        contentType,
        sizeBytes,
        body: response.body
      };
    }
  };
}

function credentialScope(
  profileId: string,
  workspaceId: string | undefined,
  resource: FeedbackResourceRefV2 | undefined,
  operation: FeedbackOperationV2
): FeedbackRequestCredentialScope {
  return {
    profileId,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(resource === undefined ? {} : { resource: { ...resource } }),
    operation
  };
}

async function resolveCredentialHeaders(
  provider: FeedbackRequestCredentialProvider | undefined,
  scope: FeedbackRequestCredentialScope
): Promise<Readonly<Record<string, string>>> {
  if (!provider) return {};
  const credentials = await provider(scope);
  if (credentials === undefined) return {};
  if (typeof credentials !== "object" || credentials === null ||
    Object.keys(credentials).some((key) => key !== "bearerToken" && key !== "participantCredential")) {
    throw new Error("request credential responseが不正です");
  }
  const bearerToken = validateCredentialValue(credentials.bearerToken, "bearerToken");
  const participantCredential = validateCredentialValue(credentials.participantCredential, "participantCredential");
  if (bearerToken !== undefined && participantCredential !== undefined) {
    throw new Error("Bearer tokenとparticipant credentialは同時指定できません");
  }
  return {
    ...(bearerToken === undefined ? {} : { Authorization: `Bearer ${bearerToken}` }),
    ...(participantCredential === undefined ? {} : { "X-Feedback-Participant-Credential": participantCredential })
  };
}

function validateCredentialValue(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 8_192 || /[\r\n]/u.test(value)) {
    throw new Error(`${name}が不正です`);
  }
  return value;
}

async function readJsonResponse<T>(response: FeedbackHttpResponse): Promise<T> {
  if (response.status < 200 || response.status >= 300) await throwProblem(response);
  if (header(response.headers, "content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    await response.dispose?.();
    throw transportProblem(response.status, "JSON responseのmedia typeが不正です");
  }
  try {
    return await response.json() as T;
  } catch {
    throw transportProblem(response.status, "JSON responseを解析できません");
  }
}

async function throwProblem(response: FeedbackHttpResponse): Promise<never> {
  let candidate: unknown;
  if (header(response.headers, "content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/problem+json") {
    try { candidate = await response.json(); } catch { /* provider本文をerrorへ含めない */ }
  }
  const retryAfter = retryAfterSeconds(header(response.headers, "retry-after"));
  if (isFeedbackProblem(candidate) && candidate.status === response.status &&
    (retryAfter === undefined || candidate.retryAfterSeconds === undefined || retryAfter === candidate.retryAfterSeconds)) {
    throw new FeedbackClientProblem({
      ...candidate,
      ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter })
    });
  }
  throw transportProblem(response.status, "HTTP error responseがFeedbackProblem契約を満たしません", retryAfter);
}

function transportProblem(status: number, detail: string, retryAfterSeconds?: number): FeedbackClientProblem {
  const codeByStatus: Partial<Record<number, FeedbackProblemV2["code"]>> = {
    400: "feedback.invalid_request", 401: "feedback.unauthorized", 403: "feedback.forbidden",
    404: "feedback.not_found", 409: "feedback.conflict", 413: "feedback.payload_too_large",
    415: "feedback.unsupported_media_type", 429: "feedback.rate_limited", 504: "feedback.provider_timeout"
  };
  const code = codeByStatus[status] ?? "feedback.provider_unavailable";
  return new FeedbackClientProblem({
    type: "https://feedback.invalid/problems/transport",
    title: "Feedback Service response error",
    status: status >= 400 && status <= 599 ? status : 502,
    code,
    detail,
    retryable: status === 429 || status === 502 || status === 503 || status === 504,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
  });
}

function isFeedbackProblem(value: unknown): value is FeedbackProblemV2 {
  if (typeof value !== "object" || value === null) return false;
  const problem = value as Partial<FeedbackProblemV2>;
  const allowedKeys = new Set(["type", "title", "status", "code", "detail", "traceId", "retryable", "retryAfterSeconds", "conflict"]);
  const codes = new Set<FeedbackProblemV2["code"]>([
    "feedback.invalid_request", "feedback.unauthorized", "feedback.forbidden", "feedback.not_found",
    "feedback.conflict", "feedback.cursor_invalid", "feedback.integrity_error", "feedback.provider_unavailable",
    "feedback.provider_timeout", "feedback.authorization_unavailable", "feedback.rate_limited",
    "feedback.payload_too_large", "feedback.unsupported_media_type", "feedback.unsupported"
  ]);
  return Object.keys(value).every((key) => allowedKeys.has(key)) &&
    typeof problem.type === "string" && problem.type.length >= 1 && problem.type.length <= 512 &&
    typeof problem.title === "string" && problem.title.length >= 1 && problem.title.length <= 200 &&
    Number.isSafeInteger(problem.status) && problem.status! >= 400 && problem.status! <= 599 &&
    typeof problem.code === "string" && codes.has(problem.code as FeedbackProblemV2["code"]) &&
    typeof problem.retryable === "boolean" &&
    (problem.detail === undefined || typeof problem.detail === "string") &&
    (problem.traceId === undefined || typeof problem.traceId === "string") &&
    (problem.retryAfterSeconds === undefined || Number.isSafeInteger(problem.retryAfterSeconds));
}

function normalizeBasePath(path: string): string {
  if (!/^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@\/-]+$/u.test(path) || /(?:^|\/)\.\.?($|\/)|[?#\\]/u.test(path)) {
    throw new Error("basePathは安全なsame-origin相対pathである必要があります");
  }
  return path.replace(/\/$/u, "");
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function scopeQuery(
  workspaceId: string | undefined,
  resource: { kind: string; key: string },
  extra: Readonly<Record<string, string | undefined>> = {}
): string {
  return queryString({
    ...(workspaceId === undefined ? {} : { workspaceId }),
    resourceKind: resource.kind,
    resourceKey: resource.key,
    ...extra
  });
}

function queryString(values: Readonly<Record<string, string | undefined>>): string {
  const entries = Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return entries.length === 0 ? "" : `?${entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}`;
}

function header(headers: Readonly<Record<string, string>>, name: string): string | null {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === expected) return value;
  return null;
}

function retryAfterSeconds(value: string | null): number | undefined {
  if (value === null || !/^\d+$/u.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 86_400 ? seconds : undefined;
}

function validateBoundary(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,70}$/u.test(value)) throw new Error("multipart boundaryが不正です");
  return value;
}

async function* multipartBody(boundary: string, command: FeedbackUploadAttachmentCommandV2, source: FeedbackUploadSource): AsyncIterable<Uint8Array> {
  const encode = (value: string) => new TextEncoder().encode(value);
  yield encode(`--${boundary}\r\nContent-Disposition: form-data; name="command"\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify(command)}\r\n`);
  const encodedFilename = encodeURIComponent(command.filename).replace(/'/gu, "%27");
  yield encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename*=UTF-8''${encodedFilename}\r\nContent-Type: ${command.contentType}\r\n\r\n`);
  for await (const chunk of source.stream()) yield chunk;
  yield encode(`\r\n--${boundary}--\r\n`);
}

async function* readerToAsyncIterable(reader: FeedbackFetchBodyReader, finished?: () => void): AsyncIterable<Uint8Array> {
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) return;
      if (item.value) yield item.value;
    }
  } finally {
    await reader.cancel?.();
    finished?.();
  }
}

function lazyReaderToAsyncIterable(
  body: { getReader(): FeedbackFetchBodyReader },
  finished?: () => void
): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() { return readerToAsyncIterable(body.getReader(), finished)[Symbol.asyncIterator](); }
  };
}

function contentDispositionFilename(value: string | null): string | null {
  if (!value) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(value)?.[1];
  const quoted = /filename="([^"]+)"/iu.exec(value)?.[1];
  let filename: string;
  try { filename = encoded ? decodeURIComponent(encoded) : quoted ?? ""; } catch { return null; }
  const leaf = filename.replace(/\\/gu, "/").split("/").pop()?.trim() ?? "";
  return leaf.length >= 1 && leaf.length <= 255 && !/[\u0000-\u001f\u007f]/u.test(leaf) ? leaf : null;
}
