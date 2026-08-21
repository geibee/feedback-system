import { createRedmineFeedbackPluginControllerFromRuntimeConfig } from "@geibee/feedback-redmine-plugin/loader";
import type {
  RedmineFeedbackPluginController,
  RedmineFeedbackPluginControllerState
} from "@geibee/feedback-redmine-plugin/loader";
import {
  createQuickstartAdapter,
  emitQuickstartLocationChange,
  quickstartSubscriptionCount
} from "./quickstart-adapter.js";

const initializationAbort = new AbortController();
let controller: RedmineFeedbackPluginController | null = null;
const controllerPromise = createRedmineFeedbackPluginControllerFromRuntimeConfig({
  adapter: createQuickstartAdapter(),
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
    return quickstartSubscriptionCount();
  },
  emitHostLocationChange(): void {
    emitQuickstartLocationChange();
  },
  destroy(): void {
    initializationAbort.abort();
    controller?.destroy();
  }
};

export type FeedbackFeatureFixture = typeof feedbackFeature;
