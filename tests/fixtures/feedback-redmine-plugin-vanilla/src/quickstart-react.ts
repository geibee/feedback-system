import { useEffect } from "react";
import { createRedmineFeedbackPluginControllerFromRuntimeConfig } from "@geibee/redmine-plugin/loader";
import type { RedmineFeedbackPluginController } from "@geibee/redmine-plugin/loader";
import { createQuickstartAdapter } from "./quickstart-adapter.js";

const adapter = createQuickstartAdapter();

/** Quickstartへ掲載するReact lifecycle統合例です。 */
export function FeedbackIntegration(): null {
  useEffect(() => {
    const abort = new AbortController();
    let controller: RedmineFeedbackPluginController | null = null;

    void createRedmineFeedbackPluginControllerFromRuntimeConfig({
      adapter,
      contextMenu: true,
      signal: abort.signal,
      onUnavailable: (error) => console.error("Feedbackを利用できません", error)
    }).then((created) => {
      if (abort.signal.aborted) created?.destroy();
      else controller = created;
    });

    return () => {
      abort.abort();
      controller?.destroy();
    };
  }, []);

  return null;
}
