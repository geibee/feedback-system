import type {
  RedmineAttachmentContent,
  RedmineAttachmentInput,
  RedmineCapabilitiesV1,
  RedmineClientProfileV1,
  RedmineCurrentPrincipalV1,
  RedmineCreationOptionsV1,
  RedmineMessageCreateInput,
  RedmineMessageUpdateInput,
  RedmineParticipantV1,
  RedmineThreadCreateInput,
  RedmineThreadListInput,
  RedmineThreadListResult,
  RedmineThreadLookupInput,
  RedmineThreadV1
} from "./model.js";

export type RedmineProfileResult = {
  profile: RedmineClientProfileV1;
  capabilities: RedmineCapabilitiesV1;
};

export interface RedmineFeedbackPort {
  getOrCreateParticipant(profileId: string, signal?: AbortSignalLike): Promise<RedmineParticipantV1>;
  getCapabilities(profileId: string, signal?: AbortSignalLike): Promise<RedmineProfileResult>;
  getCreationOptions?(profileId: string, signal?: AbortSignalLike): Promise<RedmineCreationOptionsV1>;
  getCurrentUser(profileId: string, signal?: AbortSignalLike): Promise<RedmineCurrentPrincipalV1>;
  listThreads(input: RedmineThreadListInput, signal?: AbortSignalLike): Promise<RedmineThreadListResult>;
  getThread(input: RedmineThreadLookupInput, signal?: AbortSignalLike): Promise<RedmineThreadV1>;
  createThread(
    input: RedmineThreadCreateInput,
    evidenceBytes: Uint8Array | null,
    signal?: AbortSignalLike
  ): Promise<RedmineThreadV1>;
  createMessage(input: RedmineMessageCreateInput, signal?: AbortSignalLike): Promise<RedmineThreadV1>;
  updateMessage(input: RedmineMessageUpdateInput, signal?: AbortSignalLike): Promise<RedmineThreadV1>;
  getAttachment(input: RedmineAttachmentInput, signal?: AbortSignalLike): Promise<RedmineAttachmentContent>;
}

export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener?(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener?(type: "abort", listener: () => void): void;
}
