import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeedbackRedmineHostAdapter } from "@geibee/feedback-redmine-core";
import {
  createRedmineFeedbackPluginControllerInternal,
  type RedmineFeedbackPluginControllerOptions
} from "./loader-controller.js";
import type { RedmineFeedbackPluginHandle } from "./mount.js";
import type { RedmineFeedbackPluginOptions } from "./validation.js";
import { purgeBrowserClientState } from "./storage.js";

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

const baseOptions: RedmineFeedbackPluginControllerOptions = {
  profileId: "inventory-production",
  adapter,
};

function handle(): RedmineFeedbackPluginHandle {
  return {
    refresh: async () => undefined,
    openThread: async () => undefined,
    clearLocalState: async () => undefined,
    downloadDiagnostics: () => undefined,
    destroy: vi.fn()
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});

describe("SPA plugin controller", () => {
  it("作成しただけではpluginとstorageを読み込まない", () => {
    const importPlugin = vi.fn();
    const importStorage = vi.fn();
    const controller = createRedmineFeedbackPluginControllerInternal(baseOptions, importPlugin, importStorage);
    expect(controller.state).toBe("disabled");
    expect(controller.getHandle()).toBeNull();
    expect(importPlugin).not.toHaveBeenCalled();
    expect(importStorage).not.toHaveBeenCalled();
    expect(document.querySelector("[data-feedback-redmine-host]")).toBeNull();
  });

  it("loading中とenabled後の二重enableでimportとmountを重複しない", async () => {
    const loaded = deferred<{
      createRedmineFeedbackPlugin(options: RedmineFeedbackPluginOptions): RedmineFeedbackPluginHandle;
    }>();
    const mountedHandle = handle();
    const createPlugin = vi.fn((_options: RedmineFeedbackPluginOptions) => mountedHandle);
    const importPlugin = vi.fn(() => loaded.promise);
    const controller = createRedmineFeedbackPluginControllerInternal(baseOptions, importPlugin, vi.fn());

    const first = controller.setEnabled(true);
    const duplicate = controller.setEnabled(true);
    expect(duplicate).toBe(first);
    expect(controller.state).toBe("loading");
    expect(importPlugin).toHaveBeenCalledOnce();
    loaded.resolve({ createRedmineFeedbackPlugin: createPlugin });
    await first;

    expect(controller.state).toBe("enabled");
    expect(controller.getHandle()).toBe(mountedHandle);
    expect(createPlugin).toHaveBeenCalledOnce();
    expect(document.querySelectorAll("[data-feedback-redmine-host]")).toHaveLength(1);
    await controller.setEnabled(true);
    expect(importPlugin).toHaveBeenCalledOnce();
    expect(createPlugin).toHaveBeenCalledOnce();
  });

  it("load中のdisableとdestroyは遅延mountを発生させない", async () => {
    for (const operation of ["disable", "destroy"] as const) {
      const loaded = deferred<{
        createRedmineFeedbackPlugin(options: RedmineFeedbackPluginOptions): RedmineFeedbackPluginHandle;
      }>();
      const createPlugin = vi.fn((_options: RedmineFeedbackPluginOptions) => handle());
      const controller = createRedmineFeedbackPluginControllerInternal(baseOptions, () => loaded.promise, vi.fn());
      const enabling = controller.setEnabled(true);
      if (operation === "disable") await controller.setEnabled(false);
      else controller.destroy();
      loaded.resolve({ createRedmineFeedbackPlugin: createPlugin });
      await enabling;
      expect(controller.state).toBe(operation === "disable" ? "disabled" : "destroyed");
      expect(createPlugin).not.toHaveBeenCalled();
      expect(document.querySelector("[data-feedback-redmine-host]")).toBeNull();
    }
  });

  it("disableでowned mountを除去して再enableできる", async () => {
    const handles = [handle(), handle()];
    const createPlugin = vi.fn(() => handles.shift()!);
    const importPlugin = vi.fn(async () => ({ createRedmineFeedbackPlugin: createPlugin }));
    const controller = createRedmineFeedbackPluginControllerInternal(baseOptions, importPlugin, vi.fn());

    await controller.setEnabled(true);
    const first = controller.getHandle()!;
    await controller.setEnabled(false);
    await controller.setEnabled(false);
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(document.querySelector("[data-feedback-redmine-host]")).toBeNull();

    await controller.setEnabled(true);
    expect(controller.state).toBe("enabled");
    expect(controller.getHandle()).not.toBe(first);
    expect(document.querySelectorAll("[data-feedback-redmine-host]")).toHaveLength(1);
    expect(importPlugin).toHaveBeenCalledTimes(2);
  });

  it("host所有mountはdisable時に削除しない", async () => {
    const mount = document.createElement("div");
    document.body.append(mount);
    const mountedHandle = handle();
    const controller = createRedmineFeedbackPluginControllerInternal(
      { ...baseOptions, mount },
      async () => ({ createRedmineFeedbackPlugin: () => mountedHandle }),
      vi.fn()
    );
    await controller.setEnabled(true);
    await controller.setEnabled(false);
    expect(mount.isConnected).toBe(true);
    expect(mountedHandle.destroy).toHaveBeenCalledOnce();
  });

  it("loadまたはmount失敗をhostへthrowせず後からretryできる", async () => {
    const unavailable = vi.fn(() => { throw new Error("callback failure"); });
    const mountedHandle = handle();
    const importPlugin = vi.fn()
      .mockRejectedValueOnce(new Error("chunk failure"))
      .mockResolvedValueOnce({ createRedmineFeedbackPlugin: () => mountedHandle });
    const controller = createRedmineFeedbackPluginControllerInternal(
      { ...baseOptions, onUnavailable: unavailable },
      importPlugin,
      vi.fn()
    );
    await expect(controller.setEnabled(true)).resolves.toBeUndefined();
    expect(controller.state).toBe("disabled");
    expect(unavailable).toHaveBeenCalledOnce();
    expect(document.querySelector("[data-feedback-redmine-host]")).toBeNull();

    await controller.setEnabled(true);
    expect(controller.state).toBe("enabled");
    expect(controller.getHandle()).toBe(mountedHandle);
  });

  it("mount失敗時にcontroller所有要素をrollbackする", async () => {
    const unavailable = vi.fn();
    const controller = createRedmineFeedbackPluginControllerInternal(
      { ...baseOptions, onUnavailable: unavailable },
      async () => ({ createRedmineFeedbackPlugin: () => { throw new Error("mount failure"); } }),
      vi.fn()
    );

    await expect(controller.setEnabled(true)).resolves.toBeUndefined();

    expect(controller.state).toBe("disabled");
    expect(controller.getHandle()).toBeNull();
    expect(document.querySelector("[data-feedback-redmine-host]")).toBeNull();
    expect(unavailable).toHaveBeenCalledOnce();
  });

  it("mount設定不正時にowned DOMを残さない", async () => {
    const mount = document.createElement("div");
    const parent = document.createElement("div");
    const unavailable = vi.fn();
    const createPlugin = vi.fn();
    const controller = createRedmineFeedbackPluginControllerInternal(
      { ...baseOptions, mount, mountParent: parent, onUnavailable: unavailable },
      async () => ({ createRedmineFeedbackPlugin: createPlugin }),
      vi.fn()
    );
    await controller.setEnabled(true);
    expect(controller.state).toBe("disabled");
    expect(createPlugin).not.toHaveBeenCalled();
    expect(unavailable).toHaveBeenCalledOnce();
  });

  it("destroyを冪等にしdestroy後のenableをno-opにする", async () => {
    const mountedHandle = handle();
    const importPlugin = vi.fn(async () => ({ createRedmineFeedbackPlugin: () => mountedHandle }));
    const controller = createRedmineFeedbackPluginControllerInternal(baseOptions, importPlugin, vi.fn());
    await controller.setEnabled(true);
    controller.destroy();
    controller.destroy();
    await controller.setEnabled(true);
    expect(controller.state).toBe("destroyed");
    expect(mountedHandle.destroy).toHaveBeenCalledOnce();
    expect(importPlugin).toHaveBeenCalledOnce();
  });
});

describe("browser state purge", () => {
  it("現在origin/profileだけをlocalStorageとsessionStorageから削除する", () => {
    const origin = "https://inventory.example.invalid";
    const target = `feedback.redmine.v1:${origin}:inventory-production:`;
    localStorage.setItem(`${target}${"a".repeat(64)}:intent`, "target");
    sessionStorage.setItem(`${target}${"a".repeat(64)}:draft`, "target");
    localStorage.setItem(`feedback.redmine.v1:${origin}:other-profile:${"a".repeat(64)}:intent`, "other");
    localStorage.setItem("host.setting", "keep");

    purgeBrowserClientState({ profileId: "inventory-production", origin, localStorage, sessionStorage });

    expect(localStorage.getItem(`${target}${"a".repeat(64)}:intent`)).toBeNull();
    expect(sessionStorage.getItem(`${target}${"a".repeat(64)}:draft`)).toBeNull();
    expect(localStorage.getItem(`feedback.redmine.v1:${origin}:other-profile:${"a".repeat(64)}:intent`)).toBe("other");
    expect(localStorage.getItem("host.setting")).toBe("keep");
  });
});
