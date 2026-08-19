import { RedmineDiagnosticBuffer, type FeedbackHostResourceRefV1, type RedmineThreadV1 } from "@feedback/redmine-core";
import type { RedmineFetch } from "@feedback/redmine-core/trusted";
import type { ExtensionProfileV1 } from "./profile.js";
import type { ExtensionProfileRepository } from "./storage/chrome-storage.js";
import type { CredentialVault } from "./background/credential-vault.js";
import { EvidenceStaging } from "./background/evidence-staging.js";
import { ExtensionMessageHandler } from "./background/message-handler.js";

export async function fetchThreadThroughExtension(input: {
  profile: ExtensionProfileV1;
  apiKey: string;
  resourceRef: FeedbackHostResourceRefV1;
  threadId: string;
  fetch: RedmineFetch;
}): Promise<RedmineThreadV1> {
  const profiles = {
    get: async (profileId: string) => profileId === input.profile.id ? input.profile : null,
    list: async () => [input.profile]
  } as unknown as ExtensionProfileRepository;
  const vault = {
    get: async (profileId: string) => profileId === input.profile.id ? input.apiKey : null,
    unlock: async () => undefined,
    lock: async () => undefined
  } as unknown as CredentialVault;
  const handler = new ExtensionMessageHandler(
    "conformance-extension-id",
    profiles,
    vault,
    new EvidenceStaging(),
    input.fetch,
    new RedmineDiagnosticBuffer(),
    true
  );
  const requestId = crypto.randomUUID();
  const response = await handler.handle({
    contractVersion: "1",
    requestId,
    type: "redmine.thread.get.v1",
    payload: {
      profileId: input.profile.id,
      resourceRef: input.resourceRef,
      threadId: input.threadId
    }
  }, {
    id: "conformance-extension-id",
    tab: { url: `${input.profile.hostOrigins[0]}/orders/1` }
  });
  if (!response.ok || !response.result || typeof response.result !== "object") {
    throw new Error(`extension conformance operationに失敗しました: ${JSON.stringify(response)}`);
  }
  const thread = (response.result as { thread?: unknown }).thread;
  if (!thread || typeof thread !== "object") throw new Error("extension conformance threadがありません");
  return thread as RedmineThreadV1;
}
