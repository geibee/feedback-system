import { waitFor } from "@testing-library/dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeedbackRedmineHostAdapter } from "@geibee/feedback-redmine-core";
import { createRedmineFeedbackPluginControllerInternal } from "./loader-controller.js";
import { createRedmineFeedbackPlugin, type RedmineFeedbackPluginHandle } from "./mount.js";

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
    release: "2026.08.19",
    locale: "ja-JP"
  }),
  getLocation: () => null,
  getResourceRef: () => ({ schemaVersion: "1", kind: "record", key: "order-1" }),
  navigate: () => undefined
};

function successfulFetch(): typeof globalThis.fetch {
  return vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/participants")) return new Response(JSON.stringify({
      participantId: "00000000-0000-4000-8000-000000000007",
      credential: "signed-credential".repeat(4)
    }), { status: 201, headers: { "content-type": "application/json" } });
    if (url.endsWith("/me")) return new Response(JSON.stringify({
      principal: {
        participantId: "00000000-0000-4000-8000-000000000007",
        displayName: "利用者",
        source: "participant-credential"
      }
    }), { headers: { "content-type": "application/json" } });
    if (url.endsWith("/creation-options")) return new Response(JSON.stringify({ optionalIssueFields: [], priorities: [] }), {
      headers: { "content-type": "application/json" }
    });
    if (url.includes("/threads?")) return new Response(JSON.stringify({ threads: [], totalCount: 0, nextCursor: null }), {
      headers: { "content-type": "application/json" }
    });
    return new Response(JSON.stringify({
      profile,
      capabilities: { canRead: true, canCreate: true, canReply: true, canEditOwn: true, stateReadOnly: true }
    }), { headers: { "content-type": "application/json" } });
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function handle(): RedmineFeedbackPluginHandle {
  return {
    refresh: async () => undefined,
    openThread: async () => undefined,
    clearLocalState: async () => undefined,
    registerMapLibreMap: () => () => undefined,
    downloadDiagnostics: () => undefined,
    destroy: vi.fn()
  };
}

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Phase 0 plugin lifecycle characterization", () => {
  it("同じhostへmount、destroyによるunmount、再mountを行い所有Shadow Rootだけを再利用する", async () => {
    vi.stubGlobal("fetch", successfulFetch());
    const mount = document.createElement("div");
    document.body.append(mount);

    const first = createRedmineFeedbackPlugin({ mount, profileId: profile.id, adapter });
    const shadow = mount.shadowRoot;
    await waitFor(() => expect(shadow?.querySelector("[data-feedback-redmine-mount]")).toBeTruthy());
    expect(() => createRedmineFeedbackPlugin({ mount, profileId: profile.id, adapter })).toThrow(/二重mount/u);

    first.destroy();
    expect(shadow?.querySelector("[data-feedback-redmine-mount]")).toBeNull();
    const second = createRedmineFeedbackPlugin({ mount, profileId: profile.id, adapter });
    expect(mount.shadowRoot).toBe(shadow);
    await waitFor(() => expect(shadow?.querySelector("[data-feedback-redmine-mount]")).toBeTruthy());

    second.destroy();
    expect(shadow?.querySelector("[data-feedback-redmine-mount]")).toBeNull();
  });

  it("destroy後にgateway requestが遅れて失敗してもhost callbackを呼ばない", async () => {
    const requests: Array<ReturnType<typeof deferred<Response>>> = [];
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(() => {
      const request = deferred<Response>();
      requests.push(request);
      return request.promise;
    }));
    const unavailable = vi.fn();
    const mount = document.createElement("div");
    document.body.append(mount);
    const plugin = createRedmineFeedbackPlugin({
      mount,
      profileId: profile.id,
      adapter,
      onUnavailable: unavailable
    });
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));

    plugin.destroy();
    requests.forEach((request) => request.reject(new Error("late gateway failure")));
    await Promise.resolve();
    await Promise.resolve();

    expect(unavailable).not.toHaveBeenCalled();
    expect(mount.shadowRoot?.querySelector("[data-feedback-redmine-mount]")).toBeNull();
  });

  it("clearLocalState開始直後にdestroyした場合は遅延storage fallbackをhostへ通知しない", async () => {
    vi.stubGlobal("fetch", successfulFetch());
    const unavailable = vi.fn();
    const originalGetItem = Storage.prototype.getItem;
    let storageDenied = false;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
      if (storageDenied) throw new DOMException("denied", "SecurityError");
      return originalGetItem.call(this, key);
    });
    const mount = document.createElement("div");
    document.body.append(mount);
    const plugin = createRedmineFeedbackPlugin({
      mount,
      profileId: profile.id,
      adapter,
      onUnavailable: unavailable
    });
    await waitFor(() => expect(mount.shadowRoot?.querySelector(".feedback-redmine-launcher")).toBeTruthy());

    storageDenied = true;
    const clearing = plugin.clearLocalState("a".repeat(64));
    plugin.destroy();
    await clearing;

    expect(unavailable).not.toHaveBeenCalled();
    expect(mount.shadowRoot?.querySelector("[data-feedback-redmine-mount]")).toBeNull();
  });

  it("controller destroy後に遅延importが失敗してもonUnavailableを呼ばずmountしない", async () => {
    const loaded = deferred<{ createRedmineFeedbackPlugin(): RedmineFeedbackPluginHandle }>();
    const unavailable = vi.fn();
    const controller = createRedmineFeedbackPluginControllerInternal(
      { profileId: profile.id, adapter, onUnavailable: unavailable },
      () => loaded.promise,
      vi.fn()
    );
    const enabling = controller.setEnabled(true);
    controller.destroy();
    loaded.reject(new Error("late import failure"));
    await enabling;

    expect(controller.state).toBe("destroyed");
    expect(controller.getHandle()).toBeNull();
    expect(unavailable).not.toHaveBeenCalled();
    expect(document.querySelector("[data-feedback-redmine-host]")).toBeNull();
  });

  it("purge開始後にdestroyした場合は遅延storage importの結果もhost callbackも破棄する", async () => {
    const unavailable = vi.fn();
    const rejectedStorage = deferred<{ purgeBrowserClientState(options: { profileId: string }): void }>();
    const rejectedController = createRedmineFeedbackPluginControllerInternal(
      { profileId: profile.id, adapter, onUnavailable: unavailable },
      vi.fn(),
      () => rejectedStorage.promise
    );
    const rejectedPurge = rejectedController.purgeLocalState();
    rejectedController.destroy();
    rejectedStorage.reject(new Error("late storage import failure"));
    await rejectedPurge;
    expect(unavailable).not.toHaveBeenCalled();

    const purgeBrowserClientState = vi.fn();
    const resolvedStorage = deferred<{ purgeBrowserClientState(options: { profileId: string }): void }>();
    const resolvedController = createRedmineFeedbackPluginControllerInternal(
      { profileId: profile.id, adapter, onUnavailable: unavailable },
      vi.fn(),
      () => resolvedStorage.promise
    );
    const resolvedPurge = resolvedController.purgeLocalState();
    resolvedController.destroy();
    resolvedStorage.resolve({ purgeBrowserClientState });
    await resolvedPurge;

    expect(purgeBrowserClientState).not.toHaveBeenCalled();
    expect(unavailable).not.toHaveBeenCalled();
  });

  it("controllerのdisableと再enableは旧handleだけをdestroyして新handleへ置換する", async () => {
    const first = handle();
    const second = handle();
    const handles = [first, second];
    const controller = createRedmineFeedbackPluginControllerInternal(
      { profileId: profile.id, adapter },
      async () => ({ createRedmineFeedbackPlugin: () => handles.shift()! }),
      vi.fn()
    );

    await controller.setEnabled(true);
    expect(controller.getHandle()).toBe(first);
    await controller.setEnabled(false);
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(controller.getHandle()).toBeNull();
    await controller.setEnabled(true);
    expect(controller.getHandle()).toBe(second);
    expect(second.destroy).not.toHaveBeenCalled();

    controller.destroy();
    expect(second.destroy).toHaveBeenCalledOnce();
  });
});
