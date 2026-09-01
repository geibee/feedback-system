import type { FeedbackControllerCommand, FeedbackControllerPort } from "@geibee/feedback-controller";
import { FeedbackElement, defineFeedbackWebComponent, feedbackElementName } from "./element.js";

export type FeedbackPluginOptions = {
  mount: Element;
  scope: Extract<FeedbackControllerCommand, { type: "connect" }>["scope"];
  createController(): FeedbackControllerPort;
  label?: string;
  styleNonce?: string;
  unstyled?: boolean;
  defaultOpen?: boolean;
  onUnavailable?: (error: unknown) => void;
};

export type FeedbackPluginHandle = {
  readonly controller: FeedbackControllerPort;
  readonly element: FeedbackElement;
  readonly ready: Promise<void>;
  refresh(): Promise<void>;
  openThread(threadId: string): Promise<void>;
  destroy(): void;
};

const mounted = new WeakMap<Element, FeedbackPluginHandle>();

/** Reactやprovider packageへ依存せず、controller生成、接続、renderer破棄を一つのownerで扱う。 */
export function createFeedbackPlugin(options: FeedbackPluginOptions): FeedbackPluginHandle {
  if (typeof document === "undefined") throw new Error("Feedback pluginにはbrowser DOMが必要です");
  if (!(options.mount instanceof Element)) throw new Error("mountはElementである必要があります");
  if (mounted.has(options.mount)) throw new Error("同じElementへFeedback pluginを二重mountできません");
  const registry = options.mount.ownerDocument.defaultView?.customElements;
  if (!registry) throw new Error("customElements registryが利用できません");
  defineFeedbackWebComponent(registry);
  const created = options.mount.ownerDocument.createElement(feedbackElementName);
  if (!(created instanceof FeedbackElement)) throw new Error("Feedback custom elementを生成できません");
  const controller = options.createController();
  if (!controller || typeof controller.dispatch !== "function" || typeof controller.subscribe !== "function") {
    throw new Error("createControllerはFeedbackControllerPortを返す必要があります");
  }
  if (options.label) created.setAttribute("label", options.label);
  if (options.styleNonce) created.setAttribute("style-nonce", options.styleNonce);
  if (options.unstyled) created.setAttribute("unstyled", "");
  created.controller = controller;
  created.open = options.defaultOpen ?? false;
  let destroyed = false;
  const notifyUnavailable = (error: unknown) => {
    if (destroyed) return;
    try { options.onUnavailable?.(error); } catch { /* host callbackをpluginへ伝播させない */ }
  };
  const onCommandError = (event: Event) => notifyUnavailable((event as CustomEvent<{ error: unknown }>).detail.error);
  created.addEventListener("feedback-command-error", onCommandError);
  options.mount.append(created);

  const ready = controller.dispatch({ type: "connect", scope: cloneScope(options.scope) }).catch(notifyUnavailable);
  const active = () => {
    if (destroyed) throw new Error("Feedback pluginはdestroy済みです");
  };
  const handle: FeedbackPluginHandle = {
    controller,
    element: created,
    ready,
    async refresh() { active(); await created.refresh(); },
    async openThread(threadId) {
      active();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(threadId)) {
        throw new Error("threadIdがUUIDではありません");
      }
      await created.openThread(threadId);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      mounted.delete(options.mount);
      created.removeEventListener("feedback-command-error", onCommandError);
      created.destroyRenderer();
      created.remove();
      void controller.dispatch({ type: "destroy" }).catch(() => undefined);
    }
  };
  mounted.set(options.mount, handle);
  return handle;
}

function cloneScope(
  scope: Extract<FeedbackControllerCommand, { type: "connect" }>["scope"]
): Extract<FeedbackControllerCommand, { type: "connect" }>["scope"] {
  return { profileId: scope.profileId, workspaceId: scope.workspaceId, resource: { ...scope.resource } };
}
