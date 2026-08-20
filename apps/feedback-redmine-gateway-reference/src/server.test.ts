import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { createReferenceGatewayServer } from "./server.js";

const servers: Array<ReturnType<typeof createReferenceGatewayServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("標準gateway server", () => {
  it("healthを公開し、Hostではなく設定済みpublic originでCSRF検証する", async () => {
    const server = createReferenceGatewayServer({
      port: 0,
      publicOrigin: "https://app.example.test",
      allowHttpDevelopment: false,
      profiles: new Map(),
      secrets: new Map(),
      participantSigningKey: "participant-signing-test-secret-at-least-32-bytes"
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("listen addressを取得できません");
    const local = `http://127.0.0.1:${address.port}`;
    const ready = await fetch(`${local}/internal/feedback-redmine/v1/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ok" });

    const missingProfile = await fetch(`${local}/internal/feedback-redmine/v1/profiles/missing`, {
      headers: { Origin: "https://app.example.test", "Sec-Fetch-Site": "same-origin" }
    });
    expect(missingProfile.status).toBe(404);
  });
});
