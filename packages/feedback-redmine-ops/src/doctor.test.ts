import { describe, expect, it, vi } from "vitest";
import { runDoctor } from "./doctor.js";

describe("gateway doctor", () => {
  it("health、profile、participant、Redmine current userを順に確認する", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/participants")) return new Response(JSON.stringify({
        participantId: "00000000-0000-4000-8000-000000000001",
        credential: "credential"
      }), { status: 201, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    });
    const report = await runDoctor({ origin: "https://app.example.test", profileId: "inventory-production", fetch });
    expect(report.checks).toEqual([
      { key: "gateway-ready", status: "ok", detail: "HTTP 200" },
      { key: "profile", status: "ok", detail: "HTTP 200" },
      { key: "participant", status: "ok", detail: "HTTP 201" },
      { key: "redmine-current-user", status: "ok", detail: "HTTP 200" }
    ]);
    expect(fetch).toHaveBeenCalledTimes(4);
    for (const call of fetch.mock.calls) expect(call[1]?.headers).toMatchObject({ Origin: "https://app.example.test", "Sec-Fetch-Site": "same-origin" });
  });

  it("write canaryは明示指定時だけmultipart POSTする", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/participants")) return new Response(JSON.stringify({ credential: "credential" }), { status: 201 });
      if (path.endsWith("/threads")) return new Response(JSON.stringify({ thread: {} }), { status: 201 });
      return new Response("{}", { status: 200 });
    });
    const report = await runDoctor({
      origin: "https://app.example.test",
      profileId: "inventory-production",
      writeCanary: true,
      fetch
    });
    expect(report.canaryThreadId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(report.checks.at(-1)).toEqual({ key: "write-canary", status: "ok", detail: "HTTP 201" });
    expect(fetch).toHaveBeenCalledTimes(5);
  });
});
