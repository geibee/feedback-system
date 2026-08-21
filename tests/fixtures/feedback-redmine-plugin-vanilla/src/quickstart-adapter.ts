import type { RedmineFeedbackRuntimeOptions } from "@geibee/feedback-redmine-plugin/loader";

const locationSubscribers = new Set<() => void>();

/** Quickstartへ掲載する、DOM画面だけで完結する最小Host Adapterです。 */
export function createQuickstartAdapter(): RedmineFeedbackRuntimeOptions["adapter"] {
  return {
    getContext: () => ({
      schemaVersion: "1",
      applicationKey: "inventory",
      environmentKey: "production",
      externalWorkspaceKey: "production-review",
      release: "app-release",
      locale: "ja-JP"
    }),
    getLocation: () => ({
      schemaVersion: "1",
      pageKey: "orders.detail",
      routeTemplate: "/orders/{orderId}",
      pathParameters: { orderId: "sha256:replace-with-non-sensitive-value" }
    }),
    getResourceRef: () => ({
      schemaVersion: "1",
      kind: "record",
      key: "order:replace-with-stable-key"
    }),
    subscribe: (listener) => {
      locationSubscribers.add(listener);
      return () => locationSubscribers.delete(listener);
    },
    navigate: () => undefined
  };
}

export function emitQuickstartLocationChange(): void {
  locationSubscribers.forEach((listener) => listener());
}

export function quickstartSubscriptionCount(): number {
  return locationSubscribers.size;
}
