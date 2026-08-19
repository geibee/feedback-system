import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  createFeedbackRedmineGatewayHandler,
  type FeedbackRedmineGatewayHost
} from "@feedback/redmine-gateway";
import type { RedmineFetch } from "@feedback/redmine-core/trusted";
import { loadReferenceGatewayConfig, type ReferenceGatewayConfig } from "./config.js";
import { createSignedDemoSessionAdapter } from "./session-adapter.js";

export function createReferenceGatewayServer(
  config: ReferenceGatewayConfig,
  host: FeedbackRedmineGatewayHost,
  redmineFetch: RedmineFetch = globalThis.fetch
) {
  const handler = createFeedbackRedmineGatewayHandler({
    host,
    loadProfile: async (profileId) => config.profiles.get(profileId) ?? null,
    loadSecret: async (secretRef) => config.secrets.get(secretRef) ?? null,
    fetch: redmineFetch
  });
  return createServer(async (incoming, outgoing) => {
    try {
      const request = toRequest(incoming);
      const response = await handler(request);
      await writeResponse(response, outgoing);
    } catch {
      outgoing.writeHead(500, {
        "Content-Type": "application/problem+json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      outgoing.end(JSON.stringify({
        ok: false,
        error: {
          code: "redmine.unavailable",
          message: "gateway requestを処理できません",
          retryable: false,
          upstreamStatus: null,
          requestId: crypto.randomUUID()
        }
      }));
    }
  });
}

function toRequest(incoming: IncomingMessage): Request {
  const host = incoming.headers.host;
  if (!host) throw new Error("Host headerがありません");
  const origin = incoming.headers.origin;
  const scheme = origin?.startsWith("https://") ? "https" : "http";
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
    else if (value !== undefined) headers.set(name, value);
  }
  const method = incoming.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(`${scheme}://${host}${incoming.url ?? "/"}`, init);
}

async function writeResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => { headers[name] = value; });
  outgoing.writeHead(response.status, headers);
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const config = loadReferenceGatewayConfig();
  const server = createReferenceGatewayServer(config, createSignedDemoSessionAdapter(config.sessionSecret));
  server.listen(config.port, "0.0.0.0", () => {
    process.stdout.write(`Feedback Redmine gateway reference listening on ${config.port}\n`);
  });
}
