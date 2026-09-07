import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FeedbackProductionRuntime } from "./composition.js";
import { createFeedbackNodeServer } from "./listener.js";

const servers: ReturnType<typeof createFeedbackNodeServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("Feedback Service Node listener", () => {
  it("health／readinessとWeb標準Request／Response bridgeをnetwork listenerへ接続する", async () => {
    let handled: { url: string; body: string } | null = null;
    const runtime = {
      expectedOrigin: "https://app.example",
      basePath: "/internal/feedback/v2",
      hasRemoteAuthorizationProfiles: false,
      service: {
        async readiness() { return { ready: true as const, profileCount: 1 }; },
        async handle(request: Request) {
          handled = { url: request.url, body: await request.text() };
          return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { "content-type": "application/json" } });
        }
      }
    } as unknown as FeedbackProductionRuntime;
    const server = createFeedbackNodeServer({ runtime });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    await expect(fetch(`http://127.0.0.1:${port}/healthz`).then((response) => response.json())).resolves.toEqual({ status: "ok" });
    await expect(fetch(`http://127.0.0.1:${port}/readyz`).then((response) => response.json())).resolves.toEqual({ ready: true, profileCount: 1 });
    const response = await fetch(`http://127.0.0.1:${port}/internal/feedback/v2/test`, { method: "POST", body: "payload" });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(handled).toEqual({ url: "https://app.example/internal/feedback/v2/test", body: "payload" });
  });

  it("secret検証に失敗したreadinessを503へ反映する", async () => {
    const runtime = {
      expectedOrigin: "https://app.example",
      basePath: "/internal/feedback/v2",
      hasRemoteAuthorizationProfiles: false,
      service: {
        async readiness() { return { ready: false as const, profileCount: 1 }; },
        async handle() { throw new Error("readyzでは呼ばれません"); }
      }
    } as unknown as FeedbackProductionRuntime;
    const server = createFeedbackNodeServer({ runtime });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ready: false, profileCount: 1 });
  });
});
