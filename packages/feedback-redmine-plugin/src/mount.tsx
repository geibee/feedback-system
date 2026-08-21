import { createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RedmineDiagnosticBuffer } from "@geibee/feedback-redmine-core";
import {
  createDomEvidenceProvider,
  RedmineFeedbackOverlay,
  RedmineFeedbackProvider,
  installRedmineFeedbackStyles,
  type RedmineFeedbackOverlayHandle
} from "@geibee/feedback-redmine-react";
import {
  createMapLibreEvidenceProvider,
  findUnreadableMapCanvases,
  isMapLibreEvidenceProvider
} from "@geibee/feedback-maplibre";
import type { FeedbackRedmineHostAdapter } from "@geibee/feedback-redmine-core";
import { GatewayRedmineFeedbackTransport } from "./gateway-transport.js";
import { createBrowserClientState } from "./storage.js";
import { downloadDiagnosticJson } from "./diagnostic-download.js";
import {
  validateMapLibreEvidenceMap,
  type FeedbackMapLibreEvidenceMap
} from "./maplibre-registration.js";
import { validatePluginOptions, type RedmineFeedbackPluginOptions } from "./validation.js";

export type RedmineFeedbackPluginHandle = {
  refresh(): Promise<void>;
  openThread(threadId: string): Promise<void>;
  clearLocalState(principalScopeHash: string): Promise<void>;
  /** 遅延生成されたMapLibre mapを撮影対象へ登録し、戻り値で解除する。 */
  registerMapLibreMap(map: FeedbackMapLibreEvidenceMap): () => void;
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
  const registeredMaps = new Map<FeedbackMapLibreEvidenceMap, number>();
  const captureDiagnosticListeners = new Set<() => void>();
  const captureDiagnostics = {
    getWarning() {
      if (isMapLibreEvidenceProvider(options.adapter.captureEvidence)) return null;
      const registeredCanvases = new Set(Array.from(registeredMaps.keys()).flatMap((map) => {
        try {
          return [map.getCanvas()];
        } catch {
          return [];
        }
      }));
      const unregistered = findUnreadableMapCanvases(options.mount.ownerDocument).some(
        (canvas) => !registeredCanvases.has(canvas)
      );
      return unregistered
        ? "MapLibreのWebGL canvasに撮影providerが接続されていないため、スクリーンショット内の地図が白紙になる可能性があります。registerMapLibreMap(map)で地図を登録してください。"
        : null;
    },
    subscribe(listener: () => void) {
      captureDiagnosticListeners.add(listener);
      return () => captureDiagnosticListeners.delete(listener);
    }
  };
  const notifyCaptureDiagnostics = () => captureDiagnosticListeners.forEach((listener) => listener());
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
      diagnostics
    });
    clientState = createBrowserClientState({
      onFallback: (error) => options.onUnavailable?.(error)
    });
    const baseCapture = options.adapter.captureEvidence ?? createDomEvidenceProvider();
    const captureEvidence = createMapLibreEvidenceProvider({
      capture: baseCapture,
      maps: () => Array.from(registeredMaps.keys())
    });
    const adapter: FeedbackRedmineHostAdapter = {
      getContext: () => options.adapter.getContext(),
      getLocation: () => options.adapter.getLocation(),
      getResourceRef: () => options.adapter.getResourceRef(),
      navigate: (location, threadId) => options.adapter.navigate(location, threadId),
      captureEvidence,
      ...(options.adapter.subscribe
        ? { subscribe: (listener: () => void) => options.adapter.subscribe!(listener) }
        : {}),
      ...(options.adapter.getFeedbackThreadUrl
        ? { getFeedbackThreadUrl: (threadId: string) => options.adapter.getFeedbackThreadUrl!(threadId) }
        : {})
    };
    root = createRoot(container);
    root.render(<RedmineFeedbackProvider runtime={{
      port: transport,
      clientState,
      adapter,
      profileId: options.profileId,
      contextMenu: options.contextMenu ?? false,
      targetResolver: options.targetResolver,
      pinPositionProvider: options.pinPositionProvider,
      captureDiagnostics
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
    registerMapLibreMap(map) {
      active();
      const validated = validateMapLibreEvidenceMap(map);
      registeredMaps.set(validated, (registeredMaps.get(validated) ?? 0) + 1);
      notifyCaptureDiagnostics();
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        const count = registeredMaps.get(validated) ?? 0;
        if (count <= 1) registeredMaps.delete(validated);
        else registeredMaps.set(validated, count - 1);
        notifyCaptureDiagnostics();
      };
    },
    downloadDiagnostics() {
      active();
      downloadDiagnosticJson(diagnostics, options.profileId);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      registeredMaps.clear();
      notifyCaptureDiagnostics();
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
        captureDiagnosticListeners.clear();
      }
    }
  };
}
