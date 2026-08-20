import { createRedmineFeedbackPluginControllerFromRuntimeConfig } from "@feedback/redmine-plugin/loader";
import type {
  RedmineFeedbackPluginController,
  RedmineFeedbackPluginControllerState,
  RedmineFeedbackRuntimeOptions
} from "@feedback/redmine-plugin/loader";

const locationSubscribers = new Set<() => void>();

export function createVanillaAdapter(): RedmineFeedbackRuntimeOptions["adapter"] {
  return {
    getContext: () => ({
      schemaVersion: "1",
      applicationKey: "inventory",
      environmentKey: "production",
      externalWorkspaceKey: "production-review",
      release: "fixture",
      locale: "ja-JP"
    }),
    getLocation: () => ({
      schemaVersion: "1",
      pageKey: "orders.detail",
      routeTemplate: "/orders/{orderId}",
      pathParameters: { orderId: "sha256:fixture" }
    }),
    getResourceRef: () => ({ schemaVersion: "1", kind: "record", key: "fixture-order" }),
    subscribe: (listener) => {
      locationSubscribers.add(listener);
      return () => locationSubscribers.delete(listener);
    },
    navigate: () => undefined
  };
}

const initializationAbort = new AbortController();
let controller: RedmineFeedbackPluginController | null = null;
const controllerPromise = createRedmineFeedbackPluginControllerFromRuntimeConfig({
  adapter: createVanillaAdapter(),
  signal: initializationAbort.signal,
  onUnavailable: (error) => console.error("Feedback Redmineを利用できません", error)
}).then((created) => {
  if (initializationAbort.signal.aborted) {
    created?.destroy();
    return null;
  }
  controller = created;
  return created;
});

/** fixtureのruntime configとFeedback controllerを結ぶ唯一のintegration境界です。 */
export const feedbackFeature = {
  async ready(): Promise<void> {
    await controllerPromise;
  },
  async setEnabled(enabled: boolean): Promise<void> {
    await (await controllerPromise)?.setEnabled(enabled);
  },
  async purgeLocalState(): Promise<void> {
    await (await controllerPromise)?.purgeLocalState();
  },
  state(): RedmineFeedbackPluginControllerState {
    return controller?.state ?? "disabled";
  },
  activeSubscriptions(): number {
    return locationSubscribers.size;
  },
  emitHostLocationChange(): void {
    locationSubscribers.forEach((listener) => listener());
  },
  destroy(): void {
    initializationAbort.abort();
    controller?.destroy();
  }
};

export type FeedbackFeatureFixture = typeof feedbackFeature;
