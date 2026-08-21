import type { RedmineRuntimeConfigV1 } from "@geibee/feedback-contracts";
import {
  createRedmineFeedbackPluginControllerInternal,
  type RedmineFeedbackPluginController,
  type RedmineFeedbackPluginControllerOptions
} from "./loader-controller.js";
import { validateGatewayBasePath } from "./validation.js";

export const defaultRedmineRuntimeConfigPath = "/.well-known/feedback-redmine.json";
export const defaultRedmineRuntimeConfigTimeoutMs = 5_000;

export type RedmineFeedbackRuntimeOptions = Omit<
  RedmineFeedbackPluginControllerOptions,
  "profileId" | "gatewayBasePath"
> & {
  /** 既定pathを使えないsubpath配備向けの同一origin root-relative path。 */
  configPath?: string;
  /** testまたはhost固有計測で差し替えるfetch実装。 */
  fetch?: typeof globalThis.fetch;
  /** React cleanupやmicrofrontend破棄から初期化を中止するsignal。 */
  signal?: AbortSignal;
  /** runtime config取得timeout。既定5000ms、許容範囲1〜60000ms。 */
  timeoutMs?: number;
};

/**
 * 配備時の公開runtime configを読み、Feedback controllerを作成します。
 * 設定取得・検証に失敗した場合はfail-closedでnullを返します。
 */
export async function createRedmineFeedbackPluginControllerFromRuntimeConfig(
  options: RedmineFeedbackRuntimeOptions
): Promise<RedmineFeedbackPluginController | null> {
  let controller: RedmineFeedbackPluginController | null = null;
  try {
    const path = validateConfigPath(options.configPath ?? defaultRedmineRuntimeConfigPath);
    const timeoutMs = validateTimeoutMs(options.timeoutMs ?? defaultRedmineRuntimeConfigTimeoutMs);
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    if (typeof fetchImplementation !== "function") throw new Error("runtime config取得用fetchがありません");
    const requestAbort = createRequestAbort(options.signal, timeoutMs);
    let config: RedmineRuntimeConfigV1;
    try {
      const response = await fetchImplementation(path, {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        signal: requestAbort.signal
      });
      if (!response.ok) throw new Error(`runtime configを取得できません: HTTP ${response.status}`);
      const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json") throw new Error("runtime configのContent-Typeが不正です");
      config = validateRuntimeConfig(await response.json());
    } finally {
      requestAbort.dispose();
    }
    const {
      configPath: _configPath,
      fetch: _fetch,
      signal: _signal,
      timeoutMs: _timeoutMs,
      ...controllerOptions
    } = options;
    controller = createRedmineFeedbackPluginControllerInternal(
      {
        ...controllerOptions,
        profileId: config.profileId,
        gatewayBasePath: config.gatewayBasePath
      },
      () => import("./mount.js"),
      () => import("./storage.js")
    );
    const destroyOnAbort = () => controller?.destroy();
    options.signal?.addEventListener("abort", destroyOnAbort, { once: true });
    try {
      throwIfAborted(options.signal);
      if (config.enabled) await controller.setEnabled(true);
      throwIfAborted(options.signal);
      return controller;
    } finally {
      options.signal?.removeEventListener("abort", destroyOnAbort);
    }
  } catch (error) {
    controller?.destroy();
    if (!options.signal?.aborted) {
      try {
        options.onUnavailable?.(error);
      } catch {
        // host callbackの失敗でfail-closed処理を変えない。
      }
    }
    return null;
  }
}

export function validateRuntimeConfig(value: unknown): RedmineRuntimeConfigV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runtime configがobjectではありません");
  }
  const item = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "enabled", "profileId", "gatewayBasePath"]);
  const unknown = Object.keys(item).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`runtime configにunknown propertyがあります: ${unknown}`);
  if (item.schemaVersion !== "1") throw new Error("runtime config schemaVersionは1である必要があります");
  if (typeof item.enabled !== "boolean") throw new Error("runtime config enabledがbooleanではありません");
  if (typeof item.profileId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,99}$/u.test(item.profileId)) {
    throw new Error("runtime config profileIdが不正です");
  }
  if (typeof item.gatewayBasePath !== "string") throw new Error("runtime config gatewayBasePathが不正です");
  return {
    schemaVersion: "1",
    enabled: item.enabled,
    profileId: item.profileId,
    gatewayBasePath: validateGatewayBasePath(item.gatewayBasePath)
  };
}

function validateConfigPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    throw new Error("runtime config pathは同一originのabsolute pathである必要があります");
  }
  let parsed: URL;
  try {
    parsed = new URL(value, "https://feedback.invalid");
  } catch {
    throw new Error("runtime config pathが不正です");
  }
  if (parsed.origin !== "https://feedback.invalid" || parsed.username || parsed.password || parsed.hash) {
    throw new Error("runtime config pathが不正です");
  }
  for (const segment of value.split(/[?#]/u, 1)[0]!.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error("runtime config pathのpercent encodingが不正です");
    }
    if (decoded === "." || decoded === "..") throw new Error("runtime config pathにdot segmentがあります");
  }
  return value;
}

function validateTimeoutMs(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 60_000) {
    throw new Error("runtime config timeoutMsは1以上60000以下のintegerである必要があります");
  }
  return value;
}

function createRequestAbort(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(callerSignal?.reason ?? new Error("runtime config取得を中止しました"));
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = globalThis.setTimeout(() => {
    controller.abort(new Error(`runtime config取得が${timeoutMs}msでtimeoutしました`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      globalThis.clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("runtime config取得を中止しました");
}
