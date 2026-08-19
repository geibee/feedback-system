import {
  createRedmineFeedbackPluginControllerInternal,
  type RedmineFeedbackPluginController,
  type RedmineFeedbackPluginControllerOptions,
  type RedmineFeedbackPluginControllerState
} from "./loader-controller.js";

export type {
  RedmineFeedbackPluginController,
  RedmineFeedbackPluginControllerOptions,
  RedmineFeedbackPluginControllerState
};

/**
 * Feedback UIを必要になるまで読込まないSPA向けcontrollerを作成します。
 * 作成しただけではDOM、通信、購読、timerを開始しません。
 */
export function createRedmineFeedbackPluginController(
  options: RedmineFeedbackPluginControllerOptions
): RedmineFeedbackPluginController {
  return createRedmineFeedbackPluginControllerInternal(
    options,
    () => import("./mount.js"),
    () => import("./storage.js")
  );
}
