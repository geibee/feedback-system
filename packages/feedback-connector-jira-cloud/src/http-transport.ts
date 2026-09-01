import {
  JiraCloudConnectorProblem,
  JiraCloudRequestCancelledError,
  type JiraCloudFetch,
  type JiraCloudFetchTransportOptions,
  type JiraCloudMultipartFileBody,
  type JiraCloudResponse,
  type JiraCloudTransport
} from "./types.js";

type AbortControllerShape = {
  readonly signal: unknown;
  abort(): void;
};

type AbortControllerConstructor = new () => AbortControllerShape;

type TimerFunctions = {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
};

/** server-side secretから組み立てたAuthorization値だけを受けるfetch transport。 */
export function createJiraCloudFetchTransport(options: JiraCloudFetchTransportOptions): JiraCloudTransport {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const maximumJsonResponseBytes = 2 * 1024 * 1024;
  if (options.authorization.length === 0) throw new Error("Jira Cloud Authorization secretがありません");
  if (!Number.isInteger(options.timeoutMilliseconds) || options.timeoutMilliseconds <= 0) {
    throw new Error("Jira Cloud timeoutMillisecondsが不正です");
  }
  const createBoundary = options.createBoundary ?? randomBoundary;

  return {
    async request(request): Promise<JiraCloudResponse> {
      if (!request.path.startsWith("/rest/api/3/") || request.path.startsWith("//")) {
        throw new Error("Jira Cloud transportはREST API v3相対pathだけを受けます");
      }
      if (request.signal?.aborted) throw new JiraCloudRequestCancelledError();

      const abortConstructor = (globalThis as unknown as { AbortController?: AbortControllerConstructor }).AbortController;
      if (!abortConstructor) throw new Error("AbortControllerがありません");
      const controller = new abortConstructor();
      const timers = globalThis as unknown as TimerFunctions;
      let timedOut = false;
      const timeout = timers.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMilliseconds);
      const unsubscribe = request.signal?.subscribe(() => controller.abort());

      const headers: Record<string, string> = {
        Accept: request.responseMode === "stream" ? "*/*" : "application/json",
        Authorization: options.authorization,
        ...request.headers
      };
      let body: string | AsyncIterable<Uint8Array> | undefined;
      let duplex: "half" | undefined;
      if (request.body?.kind === "json") {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(request.body.value);
      } else if (request.body?.kind === "multipart-file") {
        const boundary = validateBoundary(createBoundary());
        headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
        headers["Content-Length"] = String(multipartLength(boundary, request.body));
        body = multipartBody(boundary, request.body);
        duplex = "half";
      }

      try {
        const response = await fetchWithSafeRedirects(options.fetch, `${baseUrl}${request.path}`, {
          method: request.method,
          headers,
          ...(body === undefined ? {} : { body }),
          signal: controller.signal,
          ...(duplex ? { duplex } : {}),
          redirect: "manual"
        }, request.method === "GET" && request.responseMode === "stream", baseUrl);
        const responseHeaders = copyHeaders(response.headers);
        if (request.responseMode === "stream" && response.status >= 200 && response.status < 300) {
          return { status: response.status, headers: responseHeaders, body: null, ...(response.body ? { stream: response.body } : {}) };
        }
        let responseBody: unknown = null;
        if (response.status !== 204) {
          const contentType = response.headers.get("content-type") ?? "";
          responseBody = await readBoundedResponse(response, contentType, maximumJsonResponseBytes);
        }
        return { status: response.status, headers: responseHeaders, body: responseBody };
      } catch (error) {
        if (timedOut) {
          throw new JiraCloudConnectorProblem({
            message: "Jira Cloud requestがtimeoutしました",
            status: 504,
            code: "feedback.provider_timeout",
            retryable: true,
            resultUnknown: request.method !== "GET"
          });
        }
        if (request.signal?.aborted) throw new JiraCloudRequestCancelledError();
        if (error instanceof JiraCloudConnectorProblem || error instanceof JiraCloudRequestCancelledError) throw error;
        throw new JiraCloudConnectorProblem({
          message: "Jira Cloudへ接続できません",
          status: 502,
          code: "feedback.provider_unavailable",
          retryable: true,
          resultUnknown: request.method !== "GET"
        });
      } finally {
        timers.clearTimeout(timeout);
        unsubscribe?.();
      }
    }
  };
}

async function fetchWithSafeRedirects(
  fetch: JiraCloudFetch,
  initialUrl: string,
  initial: Parameters<JiraCloudFetch>[1],
  allowDownloadRedirect: boolean,
  credentialOrigin: string
) {
  let url = initialUrl;
  let headers = { ...initial.headers };
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetch(url, { ...initial, headers, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (!allowDownloadRedirect || redirects === 3) {
      throw new JiraCloudConnectorProblem({
        message: "Jira Cloud REST writeまたはredirect回数が安全境界を超えました",
        status: 502,
        code: "feedback.provider_unavailable",
        retryable: false
      });
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new JiraCloudConnectorProblem({
        message: "Jira Cloud redirect先がありません",
        status: 502,
        code: "feedback.provider_unavailable",
        retryable: false
      });
    }
    url = resolveHttpsRedirect(url, location);
    if (!url.startsWith(`${credentialOrigin}/`)) {
      headers = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== "authorization"));
    }
  }
  throw new Error("到達不能なredirect状態です");
}

function resolveHttpsRedirect(currentUrl: string, location: string): string {
  if (location.startsWith("/")) {
    if (location.startsWith("//")) throw unsafeRedirect();
    const origin = /^(https:\/\/[^/]+)/u.exec(currentUrl)?.[1];
    if (!origin) throw unsafeRedirect();
    return `${origin}${location}`;
  }
  const match = /^(https:\/\/[^/?#]+)(\/[^#]*)?$/u.exec(location);
  if (!match) throw unsafeRedirect();
  normalizeBaseUrl(match[1]!);
  return `${match[1]}${match[2] ?? "/"}`;
}

function unsafeRedirect(): JiraCloudConnectorProblem {
  return new JiraCloudConnectorProblem({
    message: "Jira Cloud redirect先が安全なHTTPS URLではありません",
    status: 502,
    code: "feedback.provider_unavailable",
    retryable: false
  });
}

async function readBoundedResponse(
  response: { headers: { get(name: string): string | null }; text(): Promise<string>; body: AsyncIterable<Uint8Array> | null },
  contentType: string,
  maximumBytes: number
): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && (!/^[0-9]+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)) {
    throw responseTooLarge();
  }
  let text: string;
  if (response.body) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > maximumBytes) throw responseTooLarge();
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const decoderConstructor = (globalThis as unknown as { TextDecoder?: new (encoding?: string, options?: { fatal?: boolean }) => { decode(input: Uint8Array): string } }).TextDecoder;
    if (!decoderConstructor) throw new Error("TextDecoderがありません");
    try {
      text = new decoderConstructor("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new JiraCloudConnectorProblem({
        message: "Jira Cloud responseのUTF-8が不正です",
        status: 502,
        code: "feedback.provider_unavailable",
        retryable: false
      });
    }
  } else {
    text = await response.text();
    if (utf8(text).byteLength > maximumBytes) throw responseTooLarge();
  }
  if (!contentType.includes("json")) return text;
  try {
    return text.length === 0 ? null : JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function responseTooLarge(): JiraCloudConnectorProblem {
  return new JiraCloudConnectorProblem({
    message: "Jira Cloud response size上限を超えました",
    status: 502,
    code: "feedback.provider_unavailable",
    retryable: false
  });
}

function normalizeBaseUrl(value: string): string {
  const match = /^https:\/\/([^/?#]+)\/?$/u.exec(value);
  if (!match) throw new Error("Jira Cloud baseUrlはHTTPS originで指定してください");
  const authority = match[1]!;
  const authorityMatch = /^([^:]+)(?::([0-9]{1,5}))?$/u.exec(authority);
  if (!authorityMatch || authorityMatch[1]!.split(".").some((label) =>
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label))) {
    throw new Error("Jira Cloud baseUrl hostが不正です");
  }
  if (authorityMatch[2] !== undefined && Number(authorityMatch[2]) > 65_535) throw new Error("Jira Cloud baseUrl portが不正です");
  return `https://${authority}`;
}

function validateBoundary(value: string): string {
  if (!/^[A-Za-z0-9_-]{16,70}$/u.test(value)) throw new Error("multipart boundaryが不正です");
  return value;
}

function randomBoundary(): string {
  const cryptoValue = globalThis as unknown as { crypto?: { getRandomValues(value: Uint8Array): Uint8Array } };
  if (!cryptoValue.crypto) throw new Error("secure random sourceがありません");
  const bytes = cryptoValue.crypto.getRandomValues(new Uint8Array(18));
  return `feedback-${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function copyHeaders(headers: { get(name: string): string | null; forEach?(callback: (value: string, key: string) => void): void }): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach?.((value, key) => { result[key.toLowerCase()] = value; });
  for (const name of ["content-type", "content-length", "retry-after"]) {
    const value = headers.get(name);
    if (value !== null) result[name] = value;
  }
  return result;
}

function multipartPrefix(boundary: string, body: JiraCloudMultipartFileBody): Uint8Array {
  const filename = body.filename.replace(/[\r\n"\\]/gu, "_");
  const contentType = body.contentType.replace(/[\r\n]/gu, "");
  return utf8(`--${boundary}\r\nContent-Disposition: form-data; name="${body.fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`);
}

function multipartSuffix(boundary: string): Uint8Array {
  return utf8(`\r\n--${boundary}--\r\n`);
}

function multipartLength(boundary: string, body: JiraCloudMultipartFileBody): number {
  return multipartPrefix(boundary, body).byteLength + body.sizeBytes + multipartSuffix(boundary).byteLength;
}

async function* multipartBody(boundary: string, body: JiraCloudMultipartFileBody): AsyncIterable<Uint8Array> {
  yield multipartPrefix(boundary, body);
  let bytesRead = 0;
  for await (const chunk of body.content) {
    bytesRead += chunk.byteLength;
    if (bytesRead > body.sizeBytes) throw new Error("attachment streamが宣言sizeを超えました");
    yield chunk;
  }
  if (bytesRead !== body.sizeBytes) throw new Error("attachment stream sizeが宣言値と一致しません");
  yield multipartSuffix(boundary);
}

function utf8(value: string): Uint8Array {
  const bytes: number[] = [];
  for (const symbol of value) {
    const point = symbol.codePointAt(0)!;
    if (point <= 0x7f) bytes.push(point);
    else if (point <= 0x7ff) bytes.push(0xc0 | point >> 6, 0x80 | point & 0x3f);
    else if (point <= 0xffff) bytes.push(0xe0 | point >> 12, 0x80 | point >> 6 & 0x3f, 0x80 | point & 0x3f);
    else bytes.push(0xf0 | point >> 18, 0x80 | point >> 12 & 0x3f, 0x80 | point >> 6 & 0x3f, 0x80 | point & 0x3f);
  }
  return Uint8Array.from(bytes);
}
