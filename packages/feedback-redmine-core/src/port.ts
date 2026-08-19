import type {
  RedmineAttachmentContent,
  RedmineAttachmentInput,
  RedmineCapabilitiesV1,
  RedmineClientProfileV1,
  RedmineCurrentPrincipalV1,
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
  getCapabilities(profileId: string, signal?: AbortSignalLike): Promise<RedmineProfileResult>;
  getCurrentUser(profileId: string, signal?: AbortSignalLike): Promise<RedmineCurrentPrincipalV1>;
  listThreads(input: RedmineThreadListInput, signal?: AbortSignalLike): Promise<RedmineThreadListResult>;
  getThread(input: RedmineThreadLookupInput, signal?: AbortSignalLike): Promise<RedmineThreadV1>;
  createThread(
    input: RedmineThreadCreateInput,
    evidenceBytes: Uint8Array | null,
    signal?: AbortSignalLike
  ): Promise<RedmineThreadV1>;
  getAttachment(input: RedmineAttachmentInput, signal?: AbortSignalLike): Promise<RedmineAttachmentContent>;
}

export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener?(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener?(type: "abort", listener: () => void): void;
}
