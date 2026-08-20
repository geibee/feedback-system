import type { FeedbackRedmineHostAdapter } from "@geibee/redmine-core";
import type { FeedbackPinPositionProvider, FeedbackTargetResolver } from "@geibee/core";

export type RedmineFeedbackPluginOptions = {
  mount: Element;
  profileId: string;
  gatewayBasePath?: string;
  adapter: FeedbackRedmineHostAdapter;
  contextMenu?: boolean;
  targetResolver?: FeedbackTargetResolver<Element>;
  pinPositionProvider?: FeedbackPinPositionProvider;
  messages?: Partial<Record<"unavailable" | "retry", string>>;
  onUnavailable?: (error: unknown) => void;
};

const profileIdPattern = /^[a-z0-9][a-z0-9._-]{0,99}$/u;

export function validatePluginOptions(value: RedmineFeedbackPluginOptions): Required<
  Pick<RedmineFeedbackPluginOptions, "mount" | "profileId" | "gatewayBasePath" | "adapter">
> & Pick<RedmineFeedbackPluginOptions, "contextMenu" | "targetResolver" | "pinPositionProvider" | "messages" | "onUnavailable"> {
  if (!value || typeof value !== "object") throw new Error("plugin optionsはobjectである必要があります");
  const allowed = new Set(["mount", "profileId", "gatewayBasePath", "adapter", "contextMenu", "targetResolver", "pinPositionProvider", "messages", "onUnavailable"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`plugin optionsにunknown propertyがあります: ${unknown}`);
  if (!(value.mount instanceof Element)) throw new Error("mountはElementである必要があります");
  if (!profileIdPattern.test(value.profileId)) throw new Error("profileIdの形式が不正です");
  if (!value.adapter || typeof value.adapter.getContext !== "function" ||
    typeof value.adapter.getLocation !== "function" || typeof value.adapter.getResourceRef !== "function") {
    throw new Error("adapterがFeedbackRedmineHostAdapterに適合しません");
  }
  if (value.contextMenu !== undefined && typeof value.contextMenu !== "boolean") throw new Error("contextMenuはbooleanである必要があります");
  if (value.targetResolver !== undefined && typeof value.targetResolver !== "function") throw new Error("targetResolverはfunctionである必要があります");
  if (value.pinPositionProvider !== undefined && (typeof value.pinPositionProvider.getPosition !== "function" ||
    typeof value.pinPositionProvider.subscribe !== "function")) throw new Error("pinPositionProviderが不正です");
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
    value.includes("@") ||
    value.length > 512
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
