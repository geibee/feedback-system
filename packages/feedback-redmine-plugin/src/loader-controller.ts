import type { RedmineFeedbackPluginHandle } from "./mount.js";
import type { RedmineFeedbackPluginOptions } from "./validation.js";

export type RedmineFeedbackPluginControllerState = "disabled" | "loading" | "enabled" | "destroyed";

export type RedmineFeedbackPluginControllerOptions = Omit<RedmineFeedbackPluginOptions, "mount"> & {
  /** hostが所有するmount先。省略時はcontrollerがdocument.body配下に生成します。 */
  mount?: Element;
  /** controller所有mountの追加先。mountとの同時指定はできません。 */
  mountParent?: Element;
};

export type RedmineFeedbackPluginController = {
  readonly state: RedmineFeedbackPluginControllerState;
  setEnabled(enabled: boolean): Promise<void>;
  getHandle(): RedmineFeedbackPluginHandle | null;
  purgeLocalState(): Promise<void>;
  destroy(): void;
};

type PluginModule = {
  createRedmineFeedbackPlugin(options: RedmineFeedbackPluginOptions): RedmineFeedbackPluginHandle;
};

type StorageModule = {
  purgeBrowserClientState(options: { profileId: string }): void;
};

type PluginImporter = () => Promise<PluginModule>;
type StorageImporter = () => Promise<StorageModule>;

/** dynamic importをtest doubleへ差し替えるためのpackage内部実装です。 */
export function createRedmineFeedbackPluginControllerInternal(
  options: RedmineFeedbackPluginControllerOptions,
  importPlugin: PluginImporter,
  importStorage: StorageImporter
): RedmineFeedbackPluginController {
  let state: RedmineFeedbackPluginControllerState = "disabled";
  let generation = 0;
  let handle: RedmineFeedbackPluginHandle | null = null;
  let ownedMount: HTMLDivElement | null = null;
  let pending: Promise<void> | null = null;
  let permanentlyDestroyed = false;

  const notifyUnavailable = (error: unknown) => {
    try {
      options.onUnavailable?.(error);
    } catch {
      // host callbackの失敗をhostのfeature flag処理へ伝播させない。
    }
  };

  const removeMountedPlugin = () => {
    const currentHandle = handle;
    handle = null;
    try {
      currentHandle?.destroy();
    } catch (error) {
      notifyUnavailable(error);
    } finally {
      ownedMount?.remove();
      ownedMount = null;
    }
  };

  const disable = () => {
    generation += 1;
    pending = null;
    removeMountedPlugin();
    if (!permanentlyDestroyed) state = "disabled";
  };

  const controller: RedmineFeedbackPluginController = {
    get state() {
      return state;
    },
    setEnabled(enabled) {
      if (permanentlyDestroyed) return Promise.resolve();
      if (!enabled) {
        disable();
        return Promise.resolve();
      }
      if (state === "enabled") return Promise.resolve();
      if (state === "loading" && pending) return pending;

      const requestGeneration = ++generation;
      state = "loading";
      let task!: Promise<void>;
      task = (async () => {
        try {
          if (options.mount !== undefined && options.mountParent !== undefined) {
            throw new Error("mountとmountParentは同時に指定できません");
          }
          const plugin = await importPlugin();
          if (permanentlyDestroyed || generation !== requestGeneration) return;
          if (typeof document === "undefined") throw new Error("plugin enableにはbrowser DOMが必要です");

          let mount = options.mount;
          if (mount === undefined) {
            const parent = options.mountParent ?? document.body;
            if (!(parent instanceof Element)) throw new Error("mountParentはElementである必要があります");
            ownedMount = document.createElement("div");
            ownedMount.dataset.feedbackRedmineHost = "true";
            parent.append(ownedMount);
            mount = ownedMount;
          }
          const { mount: _mount, mountParent: _mountParent, ...pluginOptions } = options;
          handle = plugin.createRedmineFeedbackPlugin({ ...pluginOptions, mount });
          if (permanentlyDestroyed || generation !== requestGeneration) {
            removeMountedPlugin();
            return;
          }
          state = "enabled";
        } catch (error) {
          if (!permanentlyDestroyed && generation === requestGeneration) {
            removeMountedPlugin();
            state = "disabled";
            notifyUnavailable(error);
          }
        } finally {
          if (pending === task) pending = null;
        }
      })();
      pending = task;
      return task;
    },
    getHandle() {
      return state === "enabled" ? handle : null;
    },
    async purgeLocalState() {
      try {
        const storage = await importStorage();
        storage.purgeBrowserClientState({ profileId: options.profileId });
      } catch (error) {
        notifyUnavailable(error);
      }
    },
    destroy() {
      if (permanentlyDestroyed) return;
      disable();
      permanentlyDestroyed = true;
      state = "destroyed";
    }
  };
  return controller;
}
