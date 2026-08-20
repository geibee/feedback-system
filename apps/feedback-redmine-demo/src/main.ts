import { createRedmineFeedbackPluginControllerFromRuntimeConfig } from "@feedback/redmine-plugin/loader";

const subscribers = new Set<() => void>();
const adapter = {
  getContext: () => ({
    schemaVersion: "1" as const,
    applicationKey: "feedback-demo",
    environmentKey: "local",
    externalWorkspaceKey: "local-review",
    release: "local-evaluation",
    locale: "ja-JP"
  }),
  getLocation: () => ({
    schemaVersion: "1" as const,
    pageKey: "feedback.demo",
    routeTemplate: "/",
    pathParameters: {}
  }),
  getResourceRef: () => ({ schemaVersion: "1" as const, kind: "record" as const, key: "local-demo" }),
  subscribe: (listener: () => void) => {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  },
  navigate: (location: { routeTemplate: string }) => {
    history.pushState({}, "", location.routeTemplate);
    subscribers.forEach((listener) => listener());
  }
};

const status = document.querySelector<HTMLElement>("#feedback-status");
const initializationAbort = new AbortController();
let feedback: Awaited<ReturnType<typeof createRedmineFeedbackPluginControllerFromRuntimeConfig>> = null;
void (async () => {
  const controller = await createRedmineFeedbackPluginControllerFromRuntimeConfig({
    adapter,
    contextMenu: true,
    signal: initializationAbort.signal,
    onUnavailable: (error) => {
      if (status) status.textContent = `Feedbackを利用できません: ${error instanceof Error ? error.message : String(error)}`;
    }
  });
  if (initializationAbort.signal.aborted) controller?.destroy();
  else {
    feedback = controller;
    if (controller && status) status.textContent = controller.state === "enabled" ? "Feedbackは利用できます。" : "Feedbackは無効です。";
  }
})();

window.addEventListener("pagehide", () => {
  initializationAbort.abort();
  feedback?.destroy();
}, { once: true });
