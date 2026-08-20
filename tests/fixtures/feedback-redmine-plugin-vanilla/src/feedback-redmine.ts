import { createRedmineFeedbackPluginController } from "@feedback/redmine-plugin/loader";
import type {
  RedmineFeedbackPluginControllerState,
  RedmineFeedbackPluginControllerOptions
} from "@feedback/redmine-plugin/loader";

const locationSubscribers = new Set<() => void>();

export function createVanillaAdapter(): RedmineFeedbackPluginControllerOptions["adapter"] {
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

const controller = createRedmineFeedbackPluginController({
  profileId: "inventory-production",
  adapter: createVanillaAdapter(),
  onUnavailable: (error) => console.error("Feedback Redmineを利用できません", error)
});

/** fixtureのhost feature flagとFeedback controllerを結ぶ唯一のintegration境界です。 */
export const feedbackFeature = {
  setEnabled(enabled: boolean): Promise<void> {
    return controller.setEnabled(enabled);
  },
  purgeLocalState(): Promise<void> {
    return controller.purgeLocalState();
  },
  state(): RedmineFeedbackPluginControllerState {
    return controller.state;
  },
  activeSubscriptions(): number {
    return locationSubscribers.size;
  },
  emitHostLocationChange(): void {
    locationSubscribers.forEach((listener) => listener());
  },
  destroy(): void {
    controller.destroy();
  }
};

export type FeedbackFeatureFixture = typeof feedbackFeature;
