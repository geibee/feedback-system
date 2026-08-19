import type { FeedbackRedmineHostAdapter } from "@feedback/redmine-core";

export type RedmineFeedbackPluginOptions = {
  mount: Element;
  profileId: string;
  gatewayBasePath?: string;
  adapter: FeedbackRedmineHostAdapter;
  getCsrfToken: () => string | Promise<string>;
  messages?: Partial<Record<"unavailable" | "retry", string>>;
  onUnavailable?: (error: unknown) => void;
};

const profileIdPattern = /^[a-z0-9][a-z0-9._-]{0,99}$/u;

export function validatePluginOptions(value: RedmineFeedbackPluginOptions): Required<
  Pick<RedmineFeedbackPluginOptions, "mount" | "profileId" | "gatewayBasePath" | "adapter" | "getCsrfToken">
> & Pick<RedmineFeedbackPluginOptions, "messages" | "onUnavailable"> {
  if (!value || typeof value !== "object") throw new Error("plugin optionsはobjectである必要があります");
  const allowed = new Set(["mount", "profileId", "gatewayBasePath", "adapter", "getCsrfToken", "messages", "onUnavailable"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`plugin optionsにunknown propertyがあります: ${unknown}`);
  if (!(value.mount instanceof Element)) throw new Error("mountはElementである必要があります");
  if (!profileIdPattern.test(value.profileId)) throw new Error("profileIdの形式が不正です");
  if (!value.adapter || typeof value.adapter.getContext !== "function" ||
    typeof value.adapter.getLocation !== "function" || typeof value.adapter.getResourceRef !== "function") {
    throw new Error("adapterがFeedbackRedmineHostAdapterに適合しません");
  }
  if (typeof value.getCsrfToken !== "function") throw new Error("getCsrfTokenは必須です");
  if (value.onUnavailable !== undefined && typeof value.onUnavailable !== "function") {
    throw new Error("onUnavailableがfunctionではありません");
  }
  return { ...value, gatewayBasePath: validateGatewayBasePath(value.gatewayBasePath ?? "/internal/feedback-redmine/v1") };
}

export function validateGatewayBasePath(value: string): string {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("@")
  ) throw new Error("gatewayBasePathは同一originのrelative pathである必要があります");
  for (const segment of value.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error("gatewayBasePathのpercent encodingが不正です");
    }
    if (decoded === "." || decoded === "..") throw new Error("gatewayBasePathにdot segmentは指定できません");
  }
  return value.length > 1 ? value.replace(/\/+$/u, "") : value;
}
