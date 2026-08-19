import { createRedmineFeedbackPlugin } from "@feedback/redmine-plugin";
import type { RedmineFeedbackPluginOptions } from "@feedback/redmine-plugin";

export function createVanillaAdapter(): RedmineFeedbackPluginOptions["adapter"] {
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
    navigate: () => undefined
  };
}

const mount = typeof document === "undefined" ? null : document.querySelector("#feedback-root");
if (mount && typeof document !== "undefined") {
  createRedmineFeedbackPlugin({
    mount,
    profileId: "inventory-production",
    adapter: createVanillaAdapter(),
    getCsrfToken: () => document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? "",
    onUnavailable: (error) => console.error("Feedback Redmineを利用できません", error)
  });
}
