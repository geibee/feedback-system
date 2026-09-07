import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { FeedbackProductionRuntime } from "./composition.js";

export type FeedbackAuthenticatedSubjectAdapter = (request: IncomingMessage) => Promise<string | undefined>;

export function createFeedbackNodeServer(input: {
  runtime: FeedbackProductionRuntime;
  authenticateSubject?: FeedbackAuthenticatedSubjectAdapter;
}): Server {
  if (input.runtime.hasRemoteAuthorizationProfiles && !input.authenticateSubject) {
    throw new Error("remote-authorization profileには認証済みsubject adapterが必要です");
  }
  return createServer(async (request, response) => {
    try {
      if (request.url === "/healthz" && request.method === "GET") return json(response, 200, { status: "ok" });
      if (request.url === "/readyz" && request.method === "GET") {
        try {
          const readiness = await input.runtime.service.readiness();
          return json(response, readiness.ready ? 200 : 503, readiness);
        } catch {
          return json(response, 503, { ready: false });
        }
      }
      const subject = input.authenticateSubject ? await input.authenticateSubject(request) : undefined;
      const webRequest = toWebRequest(request, input.runtime.expectedOrigin);
      const webResponse = await input.runtime.service.handle(webRequest, subject ? { authenticatedSubjectId: subject } : {});
      await writeWebResponse(response, webResponse);
    } catch {
      if (!response.headersSent) json(response, 500, { code: "feedback.internal_error" });
      else response.destroy();
    }
  });
}

function toWebRequest(request: IncomingMessage, expectedOrigin: string): Request {
  const method = request.method ?? "GET";
  const path = request.url ?? "/";
  if (!path.startsWith("/")) throw new Error("request targetが不正です");
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
    else if (value !== undefined) headers.set(name, value);
  }
  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(`${expectedOrigin}${path}`, {
    method,
    headers,
    signal: controller.signal,
    ...(hasBody ? { body: Readable.toWeb(request) as ReadableStream<Uint8Array>, duplex: "half" } : {})
  });
}

async function writeWebResponse(response: ServerResponse, source: Response): Promise<void> {
  response.statusCode = source.status;
  source.headers.forEach((value, name) => response.setHeader(name, value));
  if (!source.body) {
    response.end();
    return;
  }
  for await (const chunk of Readable.fromWeb(source.body as never)) {
    if (!response.write(chunk)) await new Promise<void>((resolve) => response.once("drain", resolve));
  }
  response.end();
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}
