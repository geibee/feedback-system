import type {
  ClientStatePort,
  RedmineFollowStateV1,
  RedminePendingIntentV1
} from "@feedback/redmine-core";
import type { RuntimeLike } from "./extension-transport.js";

export function createExtensionClientState(runtime: RuntimeLike): ClientStatePort {
  const send = async (type: string, payload: unknown) => {
    const requestId = crypto.randomUUID();
    const response = await runtime.sendMessage({ contractVersion: "1", requestId, type, payload }) as {
      requestId?: unknown; ok?: unknown; result?: unknown
    };
    if (response.requestId !== requestId || response.ok !== true) throw new Error("client state responseが不正です");
    return response.result;
  };
  return {
    async getFollowState(profileId, principalScopeHash, threadId) {
      return await send("client-state.follow.get.v1", { profileId, principalScopeHash, threadId }) as RedmineFollowStateV1 | null;
    },
    async setFollowState(state) {
      await send("client-state.follow.set.v1", { profileId: state.profileId, state });
    },
    async listFollowStates(profileId, principalScopeHash) {
      return await send("client-state.follow.list.v1", { profileId, principalScopeHash }) as RedmineFollowStateV1[];
    },
    async getPendingIntent(profileId, principalScopeHash) {
      return await send("client-state.intent.get.v1", { profileId, principalScopeHash }) as RedminePendingIntentV1 | null;
    },
    async setPendingIntent(profileId, principalScopeHash, intent) {
      await send("client-state.intent.set.v1", { profileId, principalScopeHash, intent });
    },
    async getDraft(profileId, principalScopeHash) {
      return await send("client-state.draft.get.v1", { profileId, principalScopeHash }) as string | null;
    },
    async setDraft(profileId, principalScopeHash, draft) {
      await send("client-state.draft.set.v1", { profileId, principalScopeHash, draft });
    },
    async clearLocalState(profileId, principalScopeHash) {
      await send("client-state.clear.v1", { profileId, principalScopeHash });
    }
  };
}
