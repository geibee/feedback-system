import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeedbackRedmineHostAdapter } from "@geibee/feedback-redmine-core";
import {
  createRedmineFeedbackPluginControllerFromRuntimeConfig,
  validateRuntimeConfig
} from "./runtime-config.js";

const adapter: FeedbackRedmineHostAdapter = {
  getContext: () => ({
    schemaVersion: "1",
    applicationKey: "inventory",
    environmentKey: "production",
    externalWorkspaceKey: "production-review",
    release: "test"
  }),
  getLocation: () => null,
  getResourceRef: () => ({ schemaVersion: "1", kind: "record", key: "order-1" }),
  navigate: () => undefined
};

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("Redmine runtime config", () => {
  it("管理者案内のplain textとHTTPS linkを検証する", () => {
    expect(validateRuntimeConfig({
      schemaVersion: "1",
      enabled: true,
      profileId: "inventory-production",
      gatewayBasePath: "/internal/feedback-redmine/v1",
      submissionNotice: {
        message: "ファイルはSharePointへ配置し、URLを共有してください。",
        link: { url: "https://sharepoint.example.test/feedback", label: "配置先を開く" }
      }
    })).toMatchObject({ submissionNotice: { message: expect.stringContaining("SharePoint") } });
    expect(() => validateRuntimeConfig({
      schemaVersion: "1",
      enabled: true,
      profileId: "inventory-production",
      gatewayBasePath: "/internal/feedback-redmine/v1",
      submissionNotice: { message: "案内", link: { url: "https://user@example.test/", label: "開く" } }
    })).toThrow(/userinfo/u);
  });

  it("無効設定ではcontrollerを作るがUIをmountしない", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: "1",
      enabled: false,
      profileId: "inventory-production",
      gatewayBasePath: "/internal/feedback-redmine/v1"
    }), { headers: { "Content-Type": "application/json; charset=utf-8" } }));
    const controller = await createRedmineFeedbackPluginControllerFromRuntimeConfig({ adapter, fetch });
    expect(controller?.state).toBe("disabled");
    expect(document.querySelector("[data-feedback-redmine-host]")).toBeNull();
    expect(fetch).toHaveBeenCalledWith("/.well-known/feedback-redmine.json", expect.objectContaining({
      cache: "no-store",
      credentials: "same-origin",
      signal: expect.any(AbortSignal)
    }));
  });

  it("取得timeoutではfail-closedにしてhostへ通知する", async () => {
    vi.useFakeTimers();
    const unavailable = vi.fn();
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const pending = createRedmineFeedbackPluginControllerFromRuntimeConfig({
      adapter,
      fetch,
      timeoutMs: 1_000,
      onUnavailable: unavailable
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toBeNull();
    expect(unavailable).toHaveBeenCalledOnce();
    expect(unavailable.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ message: expect.stringMatching(/timeout/u) }));
    expect(document.querySelector("[data-feedback-redmine-host]")).toBeNull();
  });

  it("callerの中止ではmountせずonUnavailableも呼ばない", async () => {
    const abort = new AbortController();
    const unavailable = vi.fn();
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const pending = createRedmineFeedbackPluginControllerFromRuntimeConfig({
      adapter,
      fetch,
      signal: abort.signal,
      onUnavailable: unavailable
    });

    abort.abort();

    await expect(pending).resolves.toBeNull();
    expect(unavailable).not.toHaveBeenCalled();
    expect(document.querySelector("[data-feedback-redmine-host]")).toBeNull();
  });

  it("timeoutの上限を検証する", async () => {
    const unavailable = vi.fn();
    const controller = await createRedmineFeedbackPluginControllerFromRuntimeConfig({
      adapter,
      fetch: vi.fn(),
      timeoutMs: 0,
      onUnavailable: unavailable
    });
    expect(controller).toBeNull();
    expect(unavailable).toHaveBeenCalledOnce();
  });

  it("取得失敗とsecret混入をfail-closedにする", async () => {
    const unavailable = vi.fn();
    const invalid = await createRedmineFeedbackPluginControllerFromRuntimeConfig({
      adapter,
      onUnavailable: unavailable,
      fetch: async () => new Response(JSON.stringify({
        schemaVersion: "1",
        enabled: true,
        profileId: "inventory-production",
        gatewayBasePath: "/internal/feedback-redmine/v1",
        apiKey: "secret"
      }), { headers: { "Content-Type": "application/json" } })
    });
    expect(invalid).toBeNull();
    expect(unavailable).toHaveBeenCalledOnce();
    expect(document.querySelector("[data-feedback-redmine-host]")).toBeNull();
  });

  it("別originと危険なgateway pathを拒否する", () => {
    for (const gatewayBasePath of [
      "https://gateway.example.test/v1",
      "//gateway.example.test/v1",
      "/internal/../gateway",
      "/internal/%2e%2E/gateway",
      "/internal/gateway?token=value",
      "/internal/gateway#fragment",
      "/internal/gateway@evil",
      "/internal\\gateway",
      `/${"a".repeat(512)}`
    ]) {
      expect(() => validateRuntimeConfig({
        schemaVersion: "1",
        enabled: true,
        profileId: "inventory-production",
        gatewayBasePath
      }), gatewayBasePath).toThrow();
    }
  });

  it("unknown propertyを拒否する", () => {
    expect(() => validateRuntimeConfig({
      schemaVersion: "1",
      enabled: true,
      profileId: "inventory-production",
      gatewayBasePath: "/internal/feedback-redmine/v1",
      redmineBaseUrl: "https://redmine.example.test"
    })).toThrow(/unknown property/u);
  });
});
