import type { ExtensionSender } from "./message-handler.js";
import { validateRedmineFollowState, validateRedminePendingIntent } from "@feedback/redmine-core";
import { ExtensionProfileRepository, TrustedChromeClientState } from "../storage/chrome-storage.js";

type ClientStateRequest = {
  contractVersion: "1";
  requestId: string;
  type: string;
  payload: Record<string, unknown>;
};

export class ClientStateMessageHandler {
  constructor(
    private readonly runtimeId: string,
    private readonly profiles: ExtensionProfileRepository,
    private readonly state: TrustedChromeClientState
  ) {}

  async handle(value: unknown, sender: ExtensionSender) {
    let request: ClientStateRequest;
    try {
      request = parse(value);
      await this.authorize(request.payload.profileId, sender);
      const result = await this.dispatch(request);
      return { contractVersion: "1", requestId: request.requestId, type: request.type, ok: true, result };
    } catch {
      const fallback = requestLike(value);
      return {
        contractVersion: "1", requestId: fallback.requestId, type: fallback.type, ok: false,
        error: {
          code: "redmine.permission_denied",
          message: "client state requestを処理できません",
          retryable: false,
          upstreamStatus: null,
          requestId: fallback.requestId
        }
      };
    }
  }

  private async dispatch(request: ClientStateRequest): Promise<unknown> {
    const payload = request.payload;
    const profileId = text(payload.profileId);
    if (request.type === "client-state.follow.get.v1") {
      exactPayload(payload, ["profileId", "principalScopeHash", "threadId"]);
      return this.state.getFollowState(profileId, hash(payload.principalScopeHash), text(payload.threadId));
    }
    if (request.type === "client-state.follow.set.v1") {
      exactPayload(payload, ["profileId", "state"]);
      const state = validateRedmineFollowState(payload.state);
      if (state.profileId !== profileId) throw new Error("follow state profileが一致しません");
      await this.state.setFollowState(state);
      return null;
    }
    if (request.type === "client-state.follow.list.v1") {
      exactPayload(payload, ["profileId", "principalScopeHash"]);
      return this.state.listFollowStates(profileId, hash(payload.principalScopeHash));
    }
    if (request.type === "client-state.intent.get.v1") {
      exactPayload(payload, ["profileId", "principalScopeHash"]);
      return this.state.getPendingIntent(profileId, hash(payload.principalScopeHash));
    }
    if (request.type === "client-state.intent.set.v1") {
      exactPayload(payload, ["profileId", "principalScopeHash", "intent"]);
      const intent = payload.intent === null ? null : validateRedminePendingIntent(payload.intent);
      if (intent && intent.profileId !== profileId) throw new Error("pending intent profileが一致しません");
      await this.state.setPendingIntent(profileId, hash(payload.principalScopeHash), intent);
      return null;
    }
    if (request.type === "client-state.draft.get.v1") {
      exactPayload(payload, ["profileId", "principalScopeHash"]);
      return this.state.getDraft(profileId, hash(payload.principalScopeHash));
    }
    if (request.type === "client-state.draft.set.v1") {
      exactPayload(payload, ["profileId", "principalScopeHash", "draft"]);
      await this.state.setDraft(profileId, hash(payload.principalScopeHash), payload.draft === null ? null : draft(payload.draft));
      return null;
    }
    if (request.type === "client-state.clear.v1") {
      exactPayload(payload, ["profileId", "principalScopeHash"]);
      await this.state.clearLocalState(profileId, hash(payload.principalScopeHash));
      return null;
    }
    throw new Error("client state operationが不正です");
  }

  private async authorize(profileIdValue: unknown, sender: ExtensionSender): Promise<void> {
    if (sender.id !== this.runtimeId || !sender.tab?.url) throw new Error("senderが不正です");
    const profile = await this.profiles.get(text(profileIdValue));
    if (!profile || !profile.hostOrigins.includes(new URL(sender.tab.url).origin)) throw new Error("originが不正です");
  }
}

function requestLike(value: unknown): Pick<ClientStateRequest, "requestId" | "type"> {
  const item = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    requestId: typeof item.requestId === "string" && uuidPattern.test(item.requestId) ? item.requestId : crypto.randomUUID(),
    type: typeof item.type === "string" && (operationTypes as readonly string[]).includes(item.type)
      ? item.type
      : "client-state.follow.get.v1"
  };
}

function parse(value: unknown): ClientStateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("client state requestが不正です");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !["contractVersion", "requestId", "type", "payload"].includes(key)) ||
    item.contractVersion !== "1" || typeof item.requestId !== "string" || !uuidPattern.test(item.requestId) ||
    typeof item.type !== "string" || !(operationTypes as readonly string[]).includes(item.type) || !item.payload ||
    typeof item.payload !== "object" || Array.isArray(item.payload)) {
    throw new Error("client state requestが不正です");
  }
  return item as ClientStateRequest;
}

function exactPayload(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !(key in value))) {
    throw new Error("client state payloadが不正です");
  }
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 500) throw new Error("client state valueが不正です");
  return value;
}

function draft(value: unknown): string {
  if (typeof value !== "string" || value.length > 20_000) throw new Error("draftが不正です");
  return value;
}

function hash(value: unknown): string {
  const result = text(value);
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new Error("principal scope hashが不正です");
  return result;
}

const operationTypes = [
  "client-state.follow.get.v1",
  "client-state.follow.set.v1",
  "client-state.follow.list.v1",
  "client-state.intent.get.v1",
  "client-state.intent.set.v1",
  "client-state.draft.get.v1",
  "client-state.draft.set.v1",
  "client-state.clear.v1"
] as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
