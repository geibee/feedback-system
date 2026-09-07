import {
  BacklogConnectorProblem,
  BacklogRequestCancelledError,
  type BacklogFetch,
  type BacklogFetchResponse,
  type BacklogResponse,
  type BacklogTransport
} from "./types.js";

type AbortControllerShape = { readonly signal: unknown; abort(): void };
type AbortControllerConstructor = new () => AbortControllerShape;

/** API keyをURLへ含めず、Backlog-API-Key headerへだけ変換する。 */
export function createBacklogFetchTransport(options: {
  baseUrl: string;
  apiKey: string;
  fetch: BacklogFetch;
  timeoutMilliseconds: number;
}): BacklogTransport {
  const baseUrl = normalizeOrigin(options.baseUrl);
  if (options.apiKey.length < 1 || options.apiKey.length > 4096) throw new Error("Backlog API keyが不正です");
  if (!Number.isInteger(options.timeoutMilliseconds) || options.timeoutMilliseconds < 100 || options.timeoutMilliseconds > 60_000) {
    throw new Error("Backlog timeoutMillisecondsが不正です");
  }
  return {
    async request(request): Promise<BacklogResponse> {
      if (!request.path.startsWith("/api/v2/") || request.path.startsWith("//")) {
        throw new Error("Backlog transportはAPI v2相対pathだけを受けます");
      }
      if (request.signal?.aborted) throw new BacklogRequestCancelledError();
      const Controller = (globalThis as unknown as { AbortController?: AbortControllerConstructor }).AbortController;
      if (!Controller) throw new Error("AbortControllerがありません");
      const controller = new Controller();
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMilliseconds);
      const unsubscribe = request.signal?.subscribe(() => controller.abort());
      const headers: Record<string, string> = {
        Accept: "application/json",
        "Backlog-API-Key": options.apiKey
      };
      let body: string | undefined;
      if (request.body) {
        headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
        const form = new URLSearchParams();
        for (const [name, value] of Object.entries(request.body.values)) {
          for (const item of Array.isArray(value) ? value : [value]) form.append(name, item);
        }
        body = form.toString();
      }
      try {
        const response = await options.fetch(`${baseUrl}${request.path}`, {
          method: request.method,
          headers,
          ...(body === undefined ? {} : { body }),
          signal: controller.signal,
          redirect: "error"
        });
        const text = await response.text();
        if (text.length > 2 * 1024 * 1024) throw unavailable("Backlog responseが上限を超えました", false);
        let responseBody: unknown = null;
        if (text.length > 0) {
          try { responseBody = JSON.parse(text); } catch { throw unavailable("Backlog JSON responseが不正です", false); }
        }
        return { status: response.status, headers: copyHeaders(response.headers), body: responseBody };
      } catch (error) {
        if (timedOut) {
          throw new BacklogConnectorProblem({
            message: "Backlog requestがtimeoutしました",
            status: 504,
            code: "feedback.provider_timeout",
            retryable: true,
            resultUnknown: request.method !== "GET"
          });
        }
        if (request.signal?.aborted) throw new BacklogRequestCancelledError();
        if (error instanceof BacklogConnectorProblem || error instanceof BacklogRequestCancelledError) throw error;
        throw unavailable("Backlogへ接続できません", request.method !== "GET");
      } finally {
        clearTimeout(timeout);
        unsubscribe?.();
      }
    }
  };
}

function normalizeOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Backlog baseUrlが不正です"); }
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) {
    throw new Error("Backlog baseUrlはcredentialなしのHTTPS originで指定してください");
  }
  return url.origin;
}

function copyHeaders(headers: BacklogFetchResponse["headers"]): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  headers.forEach?.((value, key) => { result[key.toLowerCase()] = value; });
  for (const name of ["content-type", "x-ratelimit-remaining", "x-ratelimit-reset", "retry-after"]) {
    const value = headers.get(name);
    if (value !== null) result[name] = value;
  }
  return Object.freeze(result);
}

function unavailable(message: string, resultUnknown: boolean): BacklogConnectorProblem {
  return new BacklogConnectorProblem({
    message,
    status: 502,
    code: "feedback.provider_unavailable",
    retryable: true,
    resultUnknown
  });
}
