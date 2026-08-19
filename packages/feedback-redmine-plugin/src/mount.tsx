import { createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RedmineDiagnosticBuffer } from "@feedback/redmine-core";
import {
  RedmineFeedbackOverlay,
  RedmineFeedbackProvider,
  installRedmineFeedbackStyles,
  type RedmineFeedbackOverlayHandle
} from "@feedback/redmine-react";
import { GatewayRedmineFeedbackTransport } from "./gateway-transport.js";
import { createBrowserClientState } from "./storage.js";
import { downloadDiagnosticJson } from "./diagnostic-download.js";
import { validatePluginOptions, type RedmineFeedbackPluginOptions } from "./validation.js";

export type RedmineFeedbackPluginHandle = {
  refresh(): Promise<void>;
  openThread(threadId: string): Promise<void>;
  clearLocalState(principalScopeHash: string): Promise<void>;
  downloadDiagnostics(): void;
  destroy(): void;
};

type MountedPlugin = { root: Root; container: HTMLDivElement };
const mounted = new WeakMap<Element, MountedPlugin>();
const ownedShadowRoots = new WeakSet<ShadowRoot>();

export function createRedmineFeedbackPlugin(
  input: RedmineFeedbackPluginOptions
): RedmineFeedbackPluginHandle {
  if (typeof document === "undefined") throw new Error("plugin mountにはbrowser DOMが必要です");
  const options = validatePluginOptions(input);
  if (mounted.has(options.mount)) throw new Error("同じElementへFeedback pluginを二重mountできません");
  const existingShadow = options.mount.shadowRoot;
  if (existingShadow && !ownedShadowRoots.has(existingShadow)) {
    throw new Error("mount先にはplugin所有でない既存Shadow Rootを指定できません");
  }
  const shadow = existingShadow ?? options.mount.attachShadow({ mode: "open" });
  ownedShadowRoots.add(shadow);
  let removeStyles: (() => void) | null = null;
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let diagnostics: RedmineDiagnosticBuffer;
  let clientState: ReturnType<typeof createBrowserClientState>;
  const overlay = createRef<RedmineFeedbackOverlayHandle>();
  try {
    removeStyles = installRedmineFeedbackStyles(shadow);
    container = document.createElement("div");
    container.dataset.feedbackRedmineMount = "true";
    shadow.append(container);

    diagnostics = new RedmineDiagnosticBuffer();
    const transport = new GatewayRedmineFeedbackTransport({
      profileId: options.profileId,
      gatewayBasePath: options.gatewayBasePath,
      getCsrfToken: options.getCsrfToken,
      diagnostics
    });
    clientState = createBrowserClientState({
      onFallback: (error) => options.onUnavailable?.(error)
    });
    root = createRoot(container);
    root.render(<RedmineFeedbackProvider runtime={{
      port: transport,
      clientState,
      adapter: options.adapter,
      profileId: options.profileId
    }}>
      <RedmineFeedbackOverlay ref={overlay} onUnavailable={options.onUnavailable} />
    </RedmineFeedbackProvider>);
    mounted.set(options.mount, { root, container });
  } catch (error) {
    try { root?.unmount(); } catch { /* 元のmount errorを維持する。 */ }
    container?.remove();
    try { removeStyles?.(); } catch { /* 元のmount errorを維持する。 */ }
    mounted.delete(options.mount);
    throw error;
  }
  let destroyed = false;

  const active = () => {
    if (destroyed) throw new Error("Feedback pluginはdestroy済みです");
  };
  return {
    async refresh() {
      active();
      await Promise.resolve();
      await overlay.current?.refresh();
    },
    async openThread(threadId) {
      active();
      if (!/^[0-9a-f-]{36}$/iu.test(threadId)) throw new Error("threadIdがUUIDではありません");
      await Promise.resolve();
      await overlay.current?.openThread(threadId);
    },
    async clearLocalState(principalScopeHash) {
      active();
      await clientState.clearLocalState(options.profileId, principalScopeHash);
    },
    downloadDiagnostics() {
      active();
      downloadDiagnosticJson(diagnostics, options.profileId);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      try {
        root.unmount();
      } catch (error) {
        try { options.onUnavailable?.(error); } catch { /* host callbackを伝播させない。 */ }
      } finally {
        container.remove();
        try {
          removeStyles();
        } catch (error) {
          try { options.onUnavailable?.(error); } catch { /* host callbackを伝播させない。 */ }
        }
        mounted.delete(options.mount);
      }
    }
  };
}
