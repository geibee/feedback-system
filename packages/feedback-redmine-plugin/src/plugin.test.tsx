import { fireEvent, waitFor } from "@testing-library/dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RedmineDiagnosticBuffer, type FeedbackRedmineHostAdapter, type RedmineThreadV1 } from "@feedback/redmine-core";
import { downloadDiagnosticJson } from "./diagnostic-download.js";
import { GatewayRedmineFeedbackTransport } from "./gateway-transport.js";
import { createRedmineFeedbackPlugin } from "./mount.js";
import { createBrowserClientState } from "./storage.js";
import { validateGatewayBasePath, validatePluginOptions } from "./validation.js";

const profile = {
  schemaVersion: "1" as const,
  id: "inventory-production",
  displayName: "Inventory / Production",
  applicationKey: "inventory",
  environmentKey: "production",
  externalWorkspaceKey: "production-review",
  perspectives: [{ code: "ux", label: "UI/UX" }],
  capture: { enabled: false, maximumUploadBytes: 10_485_760, contentTypes: ["image/png" as const] },
  attachments: { maximumInlinePreviewBytes: 10_485_760, maximumDownloadBytes: 52_428_800 },
  showRedmineLink: false
};

const adapter: FeedbackRedmineHostAdapter = {
  getContext: () => ({
    schemaVersion: "1",
    applicationKey: "inventory",
    environmentKey: "production",
    externalWorkspaceKey: "production-review",
    release: "2026.08.19"
  }),
  getLocation: () => ({
    schemaVersion: "1",
    pageKey: "orders.detail",
    routeTemplate: "/orders/{orderId}",
    pathParameters: { orderId: "sha256:value" }
  }),
  getResourceRef: () => ({ schemaVersion: "1", kind: "record", key: "order-1" }),
  navigate: () => undefined
};

const emptyThread = {
  threadId: "00000000-0000-4000-8000-000000000001",
  issueId: 123,
  subject: "subject",
  initialComment: "comment",
  latestReply: null,
  status: { id: 1, name: "新規" },
  priority: null,
  assignee: null,
  author: { id: 7, name: "投稿者" },
  perspectiveCode: "ux",
  locator: null,
  hasAttachments: false,
  createdAt: "2026-08-19T00:00:00Z",
  updatedAt: "2026-08-19T00:00:00Z",
  description: "comment",
  tracker: { id: 4, name: "Feedback" },
  timeline: [],
  attachments: [],
  redmineUrl: null,
  diagnosticCount: 0
} satisfies RedmineThreadV1;

function publicParticipantId(browserProfileId: string): string {
  return `${browserProfileId.slice(0, 14)}5${browserProfileId.slice(15)}`;
}

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("plugin validation", () => {
  it.each([
    "https://gateway.example.invalid/v1",
    "//gateway.example.invalid/v1",
    "/internal/../admin",
    "/internal/%2e%2e/admin",
    "/internal\\admin",
    "/internal/v1?url=https://evil.invalid",
    "/internal/v1#fragment"
  ])("same-origin relative path以外を拒否する: %s", (value) => {
    expect(() => validateGatewayBasePath(value)).toThrow();
  });

  it("公開optionへAPI keyやRedmine URLを混入できない", () => {
    const mount = document.createElement("div");
    const base = { mount, profileId: profile.id, adapter };
    expect(validatePluginOptions(base).gatewayBasePath).toBe("/internal/feedback-redmine/v1");
    expect(() => validatePluginOptions({ ...base, apiKey: "secret" } as never)).toThrow(/unknown property/u);
    expect(() => validatePluginOptions({ ...base, redmineBaseUrl: "https://redmine.invalid" } as never)).toThrow(/unknown property/u);
  });
});

describe("gateway transport", () => {
  it("GETをsame-origin/no-storeへ固定し任意URLを受け付けない", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      profile,
      capabilities: { canRead: true, canCreate: true, canReply: true, canEditOwn: true, stateReadOnly: true }
    }), { headers: { "content-type": "application/json" } }));
    const transport = new GatewayRedmineFeedbackTransport({
      profileId: profile.id,
      gatewayBasePath: "/internal/feedback-redmine/v1",
      fetch
    });
    await transport.getCapabilities(profile.id);
    expect(fetch).toHaveBeenCalledWith(
      "/internal/feedback-redmine/v1/profiles/inventory-production",
      expect.objectContaining({ mode: "same-origin", credentials: "same-origin", cache: "no-store", redirect: "error" })
    );
    await expect(transport.getCapabilities("other-profile")).rejects.toThrow(/一致しません/u);
  });

  it("operation結果をlocal diagnosticへ記録し、明示操作だけでJSON downloadする", async () => {
    const diagnostics = new RedmineDiagnosticBuffer();
    const transport = new GatewayRedmineFeedbackTransport({
      profileId: profile.id,
      gatewayBasePath: "/internal/feedback-redmine/v1",
      diagnostics,
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
        profile,
        capabilities: { canRead: true, canCreate: true, canReply: true, canEditOwn: true, stateReadOnly: true }
      }), { status: 200, headers: { "content-type": "application/json" } }))
    });
    await transport.getCapabilities(profile.id);
    expect(diagnostics.snapshot()).toMatchObject([{
      operation: "redmine.profile.get.v1",
      profileId: profile.id,
      httpStatus: 200,
      errorCode: null
    }]);

    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:diagnostic");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    downloadDiagnosticJson(diagnostics, profile.id);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:diagnostic");
  });

  it("createへparticipant credentialとIdempotency-Keyを設定する", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).endsWith("/participants")) {
        const browserProfileId = (JSON.parse(String(init?.body)) as { browserProfileId: string }).browserProfileId;
        return new Response(JSON.stringify({ participantId: publicParticipantId(browserProfileId), credential: "signed-credential".repeat(4) }), {
          status: 201,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ thread: emptyThread }), {
        status: 201,
        headers: { "content-type": "application/json" }
      });
    });
    const transport = new GatewayRedmineFeedbackTransport({
      profileId: profile.id,
      gatewayBasePath: "/internal/feedback-redmine/v1",
      fetch
    });
    await transport.createThread({
      profileId: profile.id,
      resourceRef: { schemaVersion: "1", kind: "record", key: "order-1" },
      threadId: emptyThread.threadId,
      intentId: "00000000-0000-4000-8000-000000000002",
      comment: "comment",
      perspectiveCode: "ux",
      location: adapter.getLocation()!,
      target: null,
      release: "2026.08.19",
      locale: "ja-JP",
      capturedAt: "2026-08-19T00:00:00Z",
      evidence: null
    }, null);
    const init = fetch.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("X-Feedback-Participant-Credential")).toBe("signed-credential".repeat(4));
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("00000000-0000-4000-8000-000000000002");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("participantをlocalStorageで再利用し、storage削除後は新しいUUIDを採番する", async () => {
    const issued: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const browserProfileId = (JSON.parse(String(init?.body)) as { browserProfileId: string }).browserProfileId;
      issued.push(browserProfileId);
      return new Response(JSON.stringify({ participantId: publicParticipantId(browserProfileId), credential: `credential-${browserProfileId}` }), {
        status: 201,
        headers: { "content-type": "application/json" }
      });
    });
    const first = new GatewayRedmineFeedbackTransport({
      profileId: profile.id,
      gatewayBasePath: "/internal/feedback-redmine/v1",
      fetch
    });
    const initial = await first.getOrCreateParticipant(profile.id);
    const reused = await new GatewayRedmineFeedbackTransport({
      profileId: profile.id,
      gatewayBasePath: "/internal/feedback-redmine/v1",
      fetch
    }).getOrCreateParticipant(profile.id);
    expect(reused.participantId).toBe(initial.participantId);
    expect(fetch).toHaveBeenCalledTimes(1);

    localStorage.clear();
    const replaced = await new GatewayRedmineFeedbackTransport({
      profileId: profile.id,
      gatewayBasePath: "/internal/feedback-redmine/v1",
      fetch
    }).getOrCreateParticipant(profile.id);
    expect(replaced.participantId).not.toBe(initial.participantId);
    expect(issued).toHaveLength(2);
  });

  it("attachmentを上限内で読込み、filenameとSHA-256を検証する", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const validSha256 = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(bytes, { headers: {
      "content-type": "application/octet-stream",
      "content-disposition": "attachment; filename*=UTF-8''..%2Fsafe.bin",
      "x-feedback-content-sha256": validSha256
    } }));
    const transport = new GatewayRedmineFeedbackTransport({
      profileId: profile.id,
      gatewayBasePath: "/internal/feedback-redmine/v1",
      fetch
    });
    const result = await transport.getAttachment({
      profileId: profile.id,
      resourceRef: { schemaVersion: "1", kind: "record", key: "order-1" },
      threadId: emptyThread.threadId,
      attachmentId: 90
    });
    expect(result.filename).toBe("safe.bin");
    expect(result.sha256).toBe(validSha256);

    fetch.mockResolvedValueOnce(new Response(bytes, { headers: {
      "content-type": "application/octet-stream",
      "x-feedback-content-sha256": "a".repeat(64)
    } }));
    await expect(transport.getAttachment({
      profileId: profile.id,
      resourceRef: { schemaVersion: "1", kind: "record", key: "order-1" },
      threadId: emptyThread.threadId,
      attachmentId: 90
    })).rejects.toMatchObject({ code: "redmine.contract_invalid" });
  });
});

describe("plugin lifecycleとstorage", () => {
  it("Shadow DOMへmountし二重mountを拒否、destroyを冪等にする", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/participants")) return new Response(JSON.stringify({
        participantId: "00000000-0000-4000-8000-000000000007",
        credential: "signed-credential".repeat(4)
      }), { status: 201, headers: { "content-type": "application/json" } });
      if (url.endsWith("/me")) return new Response(JSON.stringify({
        principal: { participantId: "00000000-0000-4000-8000-000000000007", displayName: "利用者", source: "participant-credential" }
      }), { headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({
        profile,
        capabilities: { canRead: true, canCreate: true, canReply: true, canEditOwn: true, stateReadOnly: true }
      }), { headers: { "content-type": "application/json" } });
    }));
    const mount = document.createElement("div");
    document.body.append(mount);
    const handle = createRedmineFeedbackPlugin({ mount, profileId: profile.id, adapter });
    expect(() => createRedmineFeedbackPlugin({ mount, profileId: profile.id, adapter })).toThrow(/二重mount/u);
    await waitFor(() => expect(mount.shadowRoot?.querySelector<HTMLButtonElement>("button[aria-label='Feedbackを開く']")).toBeTruthy());
    fireEvent.click(mount.shadowRoot!.querySelector<HTMLButtonElement>("button[aria-label='Feedbackを開く']")!);
    handle.destroy();
    handle.destroy();
    expect(mount.shadowRoot?.querySelector("[data-feedback-redmine-mount]")).toBeNull();
  });

  it("storage拒否時もmemory-onlyへfallbackする", async () => {
    const unavailable = vi.fn();
    const denied = {
      getItem: () => { throw new DOMException("denied", "SecurityError"); },
      setItem: () => { throw new DOMException("denied", "SecurityError"); },
      removeItem: () => { throw new DOMException("denied", "SecurityError"); },
      clear: () => undefined,
      key: () => null,
      length: 0
    } satisfies Storage;
    const state = createBrowserClientState({ localStorage: denied, sessionStorage: denied, onFallback: unavailable });
    await state.setDraft(profile.id, "a".repeat(64), "draft");
    expect(await state.getDraft(profile.id, "a".repeat(64))).toBe("draft");
    expect(await state.getDraft(profile.id, "b".repeat(64))).toBeNull();
    expect(unavailable).toHaveBeenCalledTimes(1);
  });

  it("destroy時にrequest、polling、host購読を停止する", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (init?.signal instanceof AbortSignal) signals.push(init.signal);
      const url = String(input);
      if (url.endsWith("/participants")) return new Response(JSON.stringify({
        participantId: "00000000-0000-4000-8000-000000000007",
        credential: "signed-credential".repeat(4)
      }), { status: 201, headers: { "content-type": "application/json" } });
      if (url.endsWith("/me")) return new Response(JSON.stringify({
        principal: { participantId: "00000000-0000-4000-8000-000000000007", displayName: "利用者", source: "participant-credential" }
      }), { headers: { "content-type": "application/json" } });
      if (url.includes("/threads?")) return new Response(JSON.stringify({ threads: [], nextCursor: null }), {
        headers: { "content-type": "application/json" }
      });
      return new Response(JSON.stringify({
        profile,
        capabilities: { canRead: true, canCreate: true, canReply: true, canEditOwn: true, stateReadOnly: true }
      }), { headers: { "content-type": "application/json" } });
    }));
    let activeSubscriptions = 0;
    const unsubscribe = vi.fn(() => { activeSubscriptions -= 1; });
    const lifecycleAdapter: FeedbackRedmineHostAdapter = {
      ...adapter,
      subscribe: () => {
        activeSubscriptions += 1;
        return unsubscribe;
      }
    };
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const removeListenerSpy = vi.spyOn(document, "removeEventListener");
    const mount = document.createElement("div");
    document.body.append(mount);
    const mountedPlugin = createRedmineFeedbackPlugin({
      mount,
      profileId: profile.id,
      adapter: lifecycleAdapter,
    });
    await waitFor(() => expect(mount.shadowRoot?.querySelector("button[aria-label='Feedbackを開く']")).toBeTruthy());
    fireEvent.click(mount.shadowRoot!.querySelector<HTMLButtonElement>("button[aria-label='Feedbackを開く']")!);
    await waitFor(() => expect(setIntervalSpy).toHaveBeenCalled());

    mountedPlugin.destroy();

    expect(unsubscribe).toHaveBeenCalled();
    expect(activeSubscriptions).toBe(0);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(removeListenerSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });

  it("改ざんされたbrowser stateを検証してmemory-onlyへfallbackする", async () => {
    localStorage.clear();
    sessionStorage.clear();
    const unavailable = vi.fn();
    const principalScopeHash = "a".repeat(64);
    const prefix = `feedback.redmine.v1:https://inventory.example.invalid:${profile.id}:${principalScopeHash}`;
    localStorage.setItem(`${prefix}:follow-index`, JSON.stringify([emptyThread.threadId]));
    localStorage.setItem(`${prefix}:follow:${emptyThread.threadId}`, JSON.stringify({
      schemaVersion: "1",
      profileId: profile.id,
      principalScopeHash,
      threadId: emptyThread.threadId,
      issueId: 123,
      followed: true,
      lastSeenJournalId: 0,
      lastSeenIssueUpdatedOn: "2026-08-19T00:00:00Z",
      updatedAt: "2026-08-19T00:00:00Z",
      body: "保存してはいけない本文"
    }));
    const state = createBrowserClientState({
      origin: "https://inventory.example.invalid",
      localStorage,
      sessionStorage,
      onFallback: unavailable
    });
    expect(await state.listFollowStates(profile.id, principalScopeHash)).toEqual([]);
    expect(unavailable).toHaveBeenCalledTimes(1);
  });
});
