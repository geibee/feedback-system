import type {
  FeedbackBrowserControllerPort,
  FeedbackControllerCommand,
  FeedbackControllerPort,
  FeedbackControllerSnapshot,
  FeedbackControllerWriteInput
} from "@geibee/feedback-controller";
import { feedbackWebComponentStyles } from "./styles.js";

export const feedbackElementName = "geibee-feedback" as const;
export type FeedbackCommandErrorEvent = CustomEvent<{ error: unknown; command: FeedbackControllerCommand }>;

// SSR／build toolはDOMなしでpackage exportを列挙できる。instance生成はbrowser pluginだけが行う。
const FeedbackHTMLElement: typeof HTMLElement = typeof globalThis.HTMLElement === "function"
  ? globalThis.HTMLElement
  : class HTMLElementFallback {} as typeof HTMLElement;

/**
 * controllerを所有せず、snapshotのDOM描画とcommand発行だけを行う標準renderer。
 * lifecycleの所有はcreateFeedbackPluginまたはhost integrationに置く。
 */
export class FeedbackElement extends FeedbackHTMLElement {
  static readonly observedAttributes = ["label", "style-nonce", "unstyled"];
  readonly #root: ShadowRoot;
  #controller: FeedbackControllerPort | null = null;
  #unsubscribe: (() => void) | null = null;
  #open = false;
  #destroyed = false;
  #focusOnOpen = false;
  #generation = 0;
  #focusRequest = 0;
  #lastFocusKey: string | null = null;
  #title = "";
  #revisionTarget: { messageId: string; expectedRevisionId: string } | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: "open", delegatesFocus: true });
    this.#root.addEventListener("focus", (event) => {
      this.#lastFocusKey = (event.target as HTMLElement | null)?.dataset.feedbackFocus ?? null;
    }, true);
  }

  get controller(): FeedbackControllerPort | null { return this.#controller; }
  set controller(value: FeedbackControllerPort | null) { this.bindController(value); }
  get open(): boolean { return this.#open; }
  set open(value: boolean) { this.setOpen(value); }

  connectedCallback(): void {
    if (this.#destroyed) return;
    this.#subscribe();
    this.#render();
  }

  disconnectedCallback(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  attributeChangedCallback(): void {
    if (this.isConnected && !this.#destroyed) this.#render();
  }

  bindController(controller: FeedbackControllerPort | null): void {
    if (this.#destroyed || this.#controller === controller) return;
    this.#generation += 1;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#controller = controller;
    this.#title = "";
    this.#revisionTarget = null;
    this.#subscribe();
    if (this.isConnected) this.#render();
  }

  setOpen(open: boolean): void {
    if (this.#destroyed || this.#open === open) return;
    this.#open = open;
    this.#focusOnOpen = open;
    this.#render();
    if (!open) this.#focus("launcher");
  }

  async refresh(): Promise<void> { await this.#dispatch({ type: "refresh" }); }
  async openThread(threadId: string): Promise<void> {
    this.setOpen(true);
    await this.#dispatch({ type: "select-thread", threadId });
  }

  /** plugin破棄時に購読とDOMを同期的に切り離す。controller自体のdestroyはownerが行う。 */
  destroyRenderer(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#generation += 1;
    this.#focusRequest += 1;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#controller = null;
    this.#root.replaceChildren();
  }

  #subscribe(): void {
    if (!this.isConnected || this.#unsubscribe || !this.#controller || this.#destroyed) return;
    const controller = this.#controller;
    this.#unsubscribe = controller.subscribe(() => {
      if (!this.#destroyed && this.#controller === controller) this.#render();
    });
  }

  async #dispatch(command: FeedbackControllerCommand): Promise<boolean> {
    const controller = this.#controller;
    if (!controller || this.#destroyed) return false;
    const generation = this.#generation;
    try {
      await controller.dispatch(command);
      return true;
    } catch (error) {
      if (this.#destroyed || generation !== this.#generation || controller !== this.#controller) return false;
      this.dispatchEvent(new CustomEvent("feedback-command-error", {
        bubbles: true,
        composed: true,
        detail: { error, command }
      }));
      return false;
    }
  }

  async #dispatchWrite(input: FeedbackControllerWriteInput): Promise<boolean> {
    const controller = this.#controller;
    if (!controller || this.#destroyed) return false;
    const generation = this.#generation;
    if (!isBrowserController(controller)) {
      this.#commandError(new Error("browser write compositionが接続されていません"), { type: "refresh" }, generation, controller);
      return false;
    }
    try {
      const command = await controller.createWriteCommand(input);
      if (this.#destroyed || generation !== this.#generation || controller !== this.#controller) return false;
      await controller.dispatch(command);
      return true;
    } catch (error) {
      this.#commandError(error, { type: "refresh" }, generation, controller);
      return false;
    }
  }

  #commandError(
    error: unknown,
    command: FeedbackControllerCommand,
    generation: number,
    controller: FeedbackControllerPort
  ): void {
    if (this.#destroyed || generation !== this.#generation || controller !== this.#controller) return;
    this.dispatchEvent(new CustomEvent("feedback-command-error", {
      bubbles: true, composed: true, detail: { error, command }
    }));
  }

  async #captureOrCancel(): Promise<void> {
    const controller = this.#controller;
    if (!controller) return;
    const initial = controller.getSnapshot();
    if (initial.capture === "capturing") {
      await this.#dispatch({ type: "cancel-evidence-capture" });
      return;
    }
    const targetThreadId = initial.threads.selected?.threadId;
    if (!targetThreadId) return;
    if (!await this.#dispatch({ type: "begin-evidence-capture" })) return;
    const current = controller.getSnapshot();
    if (current.capture === "captured" && current.threads.selected?.threadId === targetThreadId &&
      current.profile?.effectivePermissions.includes("feedback:attachment:upload")) {
      await this.#dispatchWrite({ type: "upload-attachment", threadId: targetThreadId });
    }
  }

  #render(): void {
    if (this.#destroyed) return;
    const activeKey = (this.#root.activeElement as HTMLElement | null)?.dataset.feedbackFocus ?? this.#lastFocusKey;
    const document = this.ownerDocument;
    const fragment = document.createDocumentFragment();
    if (!this.hasAttribute("unstyled")) {
      const style = document.createElement("style");
      const nonce = this.getAttribute("style-nonce");
      if (nonce) style.nonce = nonce;
      style.textContent = feedbackWebComponentStyles;
      fragment.append(style);
    }
    const controller = this.#controller;
    const snapshot = controller?.getSnapshot() ?? null;
    const launcher = button(document, this.getAttribute("label") || "フィードバック", "launcher", () => this.setOpen(!this.#open));
    launcher.className = "launcher";
    launcher.setAttribute("aria-expanded", String(this.#open));
    launcher.setAttribute("aria-controls", "feedback-v2-web-component-panel");
    fragment.append(launcher);
    if (this.#open) fragment.append(this.#panel(document, snapshot));
    this.#root.replaceChildren(fragment);
    if (activeKey && activeKey !== "launcher") {
      this.#focusOnOpen = false;
      this.#focus(activeKey);
    } else if (this.#focusOnOpen) {
      this.#focusOnOpen = false;
      this.#focus("close");
    } else if (activeKey) this.#focus(activeKey);
  }

  #panel(document: Document, snapshot: FeedbackControllerSnapshot | null): HTMLElement {
    const panel = document.createElement("section");
    panel.id = "feedback-v2-web-component-panel";
    panel.className = "panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "feedback-v2-web-component-title");
    panel.setAttribute("aria-busy", String(snapshot?.threads.refreshing === true || snapshot?.threads.state === "loading"));
    panel.addEventListener("keydown", (event) => this.#handleDialogKey(event));

    const header = document.createElement("header");
    header.className = "header";
    const title = document.createElement("h2");
    title.id = "feedback-v2-web-component-title";
    title.textContent = snapshot?.profile?.displayName ?? this.getAttribute("label") ?? "フィードバック";
    const close = button(document, "閉じる", "close", () => this.setOpen(false));
    close.className = "button";
    close.setAttribute("aria-label", "閉じる");
    header.append(title, close);
    panel.append(header);

    const status = document.createElement("p");
    status.className = "status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = snapshot ? statusText(snapshot) : "controllerが接続されていません";
    panel.append(status);
    if (!snapshot) return panel;

    if (snapshot.threads.error) {
      const problem = document.createElement("p");
      problem.className = "problem";
      problem.setAttribute("role", "alert");
      problem.textContent = snapshot.threads.error.title;
      panel.append(problem);
    }
    const connected = snapshot.lifecycle === "connected";
    const browserController = this.#controller !== null && isBrowserController(this.#controller);
    const permissions = new Set(snapshot.profile?.effectivePermissions ?? []);
    const canCreate = connected && browserController && permissions.has("feedback:create");
    const canReply = connected && browserController && permissions.has("feedback:reply") && Boolean(snapshot.threads.selected);
    const canRevise = connected && browserController && permissions.has("feedback:revise") && Boolean(snapshot.threads.selected);
    const canUpload = connected && browserController && permissions.has("feedback:attachment:upload") && Boolean(snapshot.threads.selected);
    if (snapshot.discovery.workspaces.length > 0) {
      const field = label(document, "ワークスペース");
      const select = document.createElement("select");
      select.disabled = !connected;
      select.dataset.feedbackFocus = "workspace";
      for (const workspace of snapshot.discovery.workspaces) {
        const option = document.createElement("option");
        option.value = workspace.workspaceId;
        option.textContent = workspace.displayName;
        option.selected = workspace.workspaceId === snapshot.discovery.selectedWorkspaceId;
        select.append(option);
      }
      select.addEventListener("change", () => void this.#dispatch({ type: "select-workspace", workspaceId: select.value }));
      field.append(select);
      panel.append(field);
    }
    if (snapshot.discovery.resources.length > 0) {
      const field = label(document, "対象");
      const select = document.createElement("select");
      select.disabled = !connected;
      select.dataset.feedbackFocus = "resource";
      snapshot.discovery.resources.forEach((resource, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = resource.displayName;
        option.selected = sameResource(resource.resource, snapshot.discovery.selectedResource);
        select.append(option);
      });
      select.addEventListener("change", () => {
        const resource = snapshot.discovery.resources[Number(select.value)]?.resource;
        if (resource) void this.#dispatch({ type: "select-resource", resource });
      });
      field.append(select);
      panel.append(field);
    }

    const actions = document.createElement("div");
    actions.className = "actions";
    const refresh = button(document, "更新", "refresh", () => void this.#dispatch({ type: "refresh" }));
    refresh.className = "button";
    refresh.disabled = !connected || snapshot.threads.refreshing;
    const targetCommand = snapshot.targetSelection === "selecting" ? "cancel-target-selection" : "begin-target-selection";
    const target = button(document, snapshot.targetSelection === "selecting" ? "対象選択を中止" : "対象を選択", "target", () => void this.#dispatch({ type: targetCommand }));
    target.className = "button";
    target.disabled = !connected;
    const captureCommand = snapshot.capture === "capturing" ? "cancel-evidence-capture" : "begin-evidence-capture";
    const capture = button(document, snapshot.capture === "capturing" ? "撮影を中止" : "証跡を撮影", "capture", () => void this.#captureOrCancel());
    capture.className = "button";
    capture.disabled = !connected || (!canUpload && captureCommand !== "cancel-evidence-capture");
    actions.append(refresh, target, capture);
    panel.append(actions);

    const list = document.createElement("ul");
    list.className = "list";
    list.setAttribute("aria-label", "フィードバックスレッド");
    for (const thread of snapshot.threads.items) {
      const item = document.createElement("li");
      const open = button(document, thread.title, `thread:${thread.threadId}`, () => void this.#dispatch({ type: "select-thread", threadId: thread.threadId }));
      open.className = "thread";
      open.setAttribute("aria-current", String(snapshot.threads.selected?.threadId === thread.threadId));
      open.disabled = !connected;
      const unread = snapshot.localState.unreadCountByThread[thread.threadId] ?? 0;
      if (unread > 0) {
        const badge = document.createElement("span");
        badge.className = "unread";
        badge.setAttribute("aria-label", `未読 ${unread}件`);
        badge.textContent = String(unread);
        open.append(badge);
      }
      item.append(open);
      list.append(item);
    }
    panel.append(list);
    if (snapshot.threads.nextCursor) {
      const more = button(document, "続きを読み込む", "load-more", () => void this.#dispatch({ type: "load-more" }));
      more.className = "button";
      more.disabled = !connected;
      panel.append(more);
    }

    const selected = snapshot.threads.selected;
    if (selected) {
      const detail = document.createElement("section");
      detail.setAttribute("aria-label", "選択したスレッド");
      const heading = document.createElement("h3");
      heading.textContent = selected.title;
      const followLabel = document.createElement("label");
      const follow = document.createElement("input");
      follow.type = "checkbox";
      follow.checked = snapshot.localState.followedThreadIds.includes(selected.threadId);
      follow.dataset.feedbackFocus = "follow";
      follow.addEventListener("change", () => void this.#dispatch({ type: follow.checked ? "follow" : "unfollow", threadId: selected.threadId }));
      followLabel.append(follow, document.createTextNode(" この端末でフォロー"));
      const messages = document.createElement("div");
      messages.className = "messages";
      for (const message of selected.messages) {
        const article = document.createElement("article");
        article.className = "message";
        const author = document.createElement("strong");
        author.textContent = message.author.displayName;
        const body = document.createElement("p");
        body.textContent = message.body;
        article.append(author, body);
        if (canRevise && message.author.kind === "participant" && message.author.isCurrentParticipant) {
          const revise = button(document, "この投稿を編集", `revise:${message.messageId}`, () => {
            this.#revisionTarget = {
              messageId: message.messageId,
              expectedRevisionId: message.revisions[message.revisions.length - 1]?.revisionId ?? message.messageId
            };
            void this.#dispatch({ type: "update-draft", value: message.body });
          });
          revise.className = "button";
          article.append(revise);
        }
        messages.append(article);
      }
      detail.append(heading, followLabel, messages);
      if (snapshot.profile?.externalNavigationPath) {
        const navigation = button(document, "関連画面へ移動", "navigation", () => void this.#dispatch({ type: "request-navigation", threadId: selected.threadId }));
        navigation.className = "button";
        detail.append(navigation);
      }
      panel.append(detail);
    }

    const draftField = label(document, "下書き");
    const draft = document.createElement("textarea");
    draft.value = snapshot.localState.draft;
    draft.maxLength = 100_000;
    draft.disabled = !connected || !(["feedback:create", "feedback:reply", "feedback:revise"] as const).some((operation) => permissions.has(operation));
    draft.dataset.feedbackFocus = "draft";
    draft.addEventListener("focus", () => { this.#lastFocusKey = "draft"; });
    draft.addEventListener("input", () => void this.#dispatch({ type: "update-draft", value: draft.value }));
    draftField.append(draft);
    panel.append(draftField);

    if (!selected) {
      const titleField = label(document, "件名");
      const title = document.createElement("input");
      title.value = this.#title;
      title.maxLength = 300;
      title.disabled = !canCreate;
      title.dataset.feedbackFocus = "title";
      title.addEventListener("input", () => {
        this.#title = title.value;
        const submit = this.#root.querySelector<HTMLButtonElement>("[data-feedback-focus=submit]");
        if (submit) submit.disabled = !canCreate || this.#title.length === 0 || snapshot.localState.draft.length === 0;
      });
      titleField.append(title);
      panel.append(titleField);
    }

    const writeActions = document.createElement("div");
    writeActions.className = "actions";
    writeActions.setAttribute("aria-label", "投稿操作");
    if (!selected) {
      const submit = button(document, "送信", "submit", () => void this.#dispatchWrite({
        type: "submit", title: this.#title, body: snapshot.localState.draft
      }));
      submit.className = "button";
      submit.disabled = !canCreate || this.#title.length === 0 || snapshot.localState.draft.length === 0;
      writeActions.append(submit);
    } else if (!this.#revisionTarget) {
      const reply = button(document, "返信", "reply", () => void this.#dispatchWrite({
        type: "reply", threadId: selected.threadId, body: snapshot.localState.draft
      }));
      reply.className = "button";
      reply.disabled = !canReply || snapshot.localState.draft.length === 0;
      writeActions.append(reply);
    } else {
      const target = this.#revisionTarget;
      const revise = button(document, "変更を保存", "revise-save", () => void this.#dispatchWrite({
        type: "revise", threadId: selected.threadId, messageId: target.messageId,
        expectedRevisionId: target.expectedRevisionId, body: snapshot.localState.draft
      }).then((sent) => { if (sent) { this.#revisionTarget = null; this.#render(); } }));
      revise.className = "button";
      revise.disabled = !canRevise || snapshot.localState.draft.length === 0;
      const cancelRevision = button(document, "編集を中止", "revise-cancel", () => {
        this.#revisionTarget = null;
        this.#render();
      });
      cancelRevision.className = "button";
      writeActions.append(revise, cancelRevision);
    }
    panel.append(writeActions);

    if (snapshot.pendingIntents.length > 0) {
      const pendingRegion = document.createElement("section");
      pendingRegion.setAttribute("aria-label", "確認が必要な操作");
      const heading = document.createElement("h3");
      heading.textContent = "確認が必要な操作";
      const pendingList = document.createElement("ul");
      pendingList.className = "list";
      for (const pending of snapshot.pendingIntents) {
        const item = document.createElement("li");
        const detail = "detail" in pending.recovery ? pending.recovery.detail : `${pending.operation}の結果を確認します`;
        item.append(document.createTextNode(`${detail} `));
        const recover = button(document, "結果を確認", `intent:${pending.intentId}`, () => void this.#dispatch({ type: "recover-intent", intentId: pending.intentId }));
        recover.className = "button";
        item.append(recover);
        pendingList.append(item);
      }
      pendingRegion.append(heading, pendingList);
      panel.append(pendingRegion);
    }
    return panel;
  }

  #handleDialogKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      this.setOpen(false);
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = this.#root.querySelector<HTMLElement>("[role=dialog]");
    if (!dialog) return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled]),select:not([disabled]),textarea:not([disabled]),input:not([disabled])")]
      .filter((element) => !element.hidden);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && this.#root.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && this.#root.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  #focus(key: string): void {
    const request = ++this.#focusRequest;
    queueMicrotask(() => {
      if (!this.#destroyed && request === this.#focusRequest) {
        this.#root.querySelector<HTMLElement>(`[data-feedback-focus="${escapeSelector(key)}"]`)?.focus();
      }
    });
  }
}

export function defineFeedbackWebComponent(
  registry: CustomElementRegistry = customElements
): CustomElementConstructor {
  const current = registry.get(feedbackElementName);
  if (current && current !== FeedbackElement) throw new Error(`${feedbackElementName}は別のcustom elementとして登録済みです`);
  if (!current) registry.define(feedbackElementName, FeedbackElement);
  return FeedbackElement;
}

function button(document: Document, text: string, focusKey: string, activate: () => void): HTMLButtonElement {
  const value = document.createElement("button");
  value.type = "button";
  value.textContent = text;
  value.dataset.feedbackFocus = focusKey;
  value.addEventListener("click", activate);
  return value;
}

function label(document: Document, text: string): HTMLLabelElement {
  const value = document.createElement("label");
  value.className = "field";
  const caption = document.createElement("span");
  caption.textContent = text;
  value.append(caption);
  return value;
}

function sameResource(
  left: FeedbackControllerSnapshot["discovery"]["selectedResource"],
  right: FeedbackControllerSnapshot["discovery"]["selectedResource"]
): boolean {
  return Boolean(left && right && left.kind === right.kind && left.key === right.key);
}

function statusText(snapshot: FeedbackControllerSnapshot): string {
  if (snapshot.lifecycle === "connecting") return "接続しています";
  if (snapshot.lifecycle === "destroyed") return "Feedbackは終了しました";
  if (snapshot.threads.refreshing) return "更新しています";
  if (snapshot.threads.state === "loading") return "読み込んでいます";
  if (snapshot.capture === "capturing") return "証跡を撮影しています";
  if (snapshot.targetSelection === "selecting") return "対象を選択してください";
  return snapshot.lifecycle === "connected" ? `${snapshot.threads.items.length}件のスレッド` : "未接続です";
}

function escapeSelector(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

function isBrowserController(controller: FeedbackControllerPort): controller is FeedbackBrowserControllerPort {
  const candidate = controller as Partial<FeedbackBrowserControllerPort>;
  return typeof candidate.createWriteCommand === "function" && typeof candidate.getCapturedEvidence === "function";
}
