import type {
  FeedbackIntentRecoveryResultV2,
  FeedbackOperationV2,
  FeedbackOrderingKeyV2,
  FeedbackProblemV2,
  FeedbackProfileV2,
  FeedbackResourceRefV2,
  FeedbackResourceSummaryV2,
  FeedbackCreateThreadCommandV2,
  FeedbackReplyCommandV2,
  FeedbackAppendRevisionCommandV2,
  FeedbackUploadAttachmentCommandV2,
  FeedbackThreadSummaryV2,
  FeedbackThreadV2,
  FeedbackWorkspaceSummaryV2
} from "@geibee/feedback-contracts/v2";
import type { FeedbackClientPort, FeedbackScopedQuery, FeedbackUploadSource } from "@geibee/feedback-client";

export type FeedbackLoadState = "idle" | "loading" | "ready" | "error";

export type FeedbackPendingIntentSnapshot = {
  scope: FeedbackScopedQuery;
  threadId: string;
  stableResultId: string;
  intentId: string;
  operation: Extract<FeedbackOperationV2, "feedback:create" | "feedback:reply" | "feedback:revise" | "feedback:attachment:upload">;
  requestHash: string;
  threadReference?: import("@geibee/feedback-contracts/v2").FeedbackThreadReferenceV2;
  recovery: FeedbackIntentRecoveryResultV2;
  retryPolicy: "recover-only" | "manual-confirmation";
};

export type FeedbackControllerLocalState = {
  threadReferences?: readonly { scope: FeedbackScopedQuery; threadId: string; threadReference: import("@geibee/feedback-contracts/v2").FeedbackThreadReferenceV2 }[];
  draft: string;
  followedThreadIds: readonly string[];
  lastViewedByThread: Readonly<Record<string, FeedbackOrderingKeyV2>>;
  unreadCountByThread: Readonly<Record<string, number>>;
};

export type FeedbackControllerSnapshot = {
  schemaVersion: "2";
  lifecycle: "disconnected" | "connecting" | "connected" | "destroyed";
  pluginLifecycle: "unmounted" | "mounted" | "destroyed";
  profile: FeedbackProfileV2 | null;
  discovery: {
    state: FeedbackLoadState;
    workspaces: readonly FeedbackWorkspaceSummaryV2[];
    selectedWorkspaceId: string | null;
    resources: readonly FeedbackResourceSummaryV2[];
    selectedResource: FeedbackResourceRefV2 | null;
  };
  threads: {
    state: FeedbackLoadState;
    items: readonly FeedbackThreadSummaryV2[];
    nextCursor: string | null;
    selected: FeedbackThreadV2 | null;
    refreshing: boolean;
    error: FeedbackProblemV2 | null;
  };
  localState: FeedbackControllerLocalState;
  pendingIntents: readonly FeedbackPendingIntentSnapshot[];
  targetSelection: "idle" | "selecting" | "selected" | "cancelled";
  capture: "idle" | "capturing" | "captured" | "cancelled";
  navigation: null | { requestId: string; path: string; state: "requested" | "acknowledged" };
};

export type FeedbackControllerCommand =
  | { type: "connect"; scope: FeedbackScopedQuery }
  | { type: "refresh" }
  | { type: "load-more" }
  | { type: "select-workspace"; workspaceId: string }
  | { type: "select-resource"; resource: FeedbackResourceRefV2 }
  | { type: "select-thread"; threadId: string }
  | { type: "follow"; threadId: string }
  | { type: "unfollow"; threadId: string }
  | { type: "update-draft"; value: string }
  | { type: "begin-target-selection" }
  | { type: "cancel-target-selection" }
  | { type: "begin-evidence-capture" }
  | { type: "cancel-evidence-capture" }
  | { type: "submit"; profileId: string; workspaceId: string; command: FeedbackCreateThreadCommandV2 }
  | { type: "reply"; scope: FeedbackScopedQuery; threadId: string; command: FeedbackReplyCommandV2 }
  | { type: "revise"; scope: FeedbackScopedQuery; threadId: string; messageId: string; command: FeedbackAppendRevisionCommandV2 }
  | { type: "upload-attachment"; scope: FeedbackScopedQuery; threadId: string; command: FeedbackUploadAttachmentCommandV2; source: FeedbackUploadSource }
  | { type: "recover-intent"; intentId: string }
  | { type: "request-navigation"; threadId: string }
  | { type: "acknowledge-navigation"; requestId: string }
  | { type: "disconnect" }
  | { type: "destroy" };

export type FeedbackControllerListener = (snapshot: FeedbackControllerSnapshot) => void;

export interface FeedbackControllerPort {
  readonly client: FeedbackClientPort;
  getSnapshot(): FeedbackControllerSnapshot;
  subscribe(listener: FeedbackControllerListener): () => void;
  dispatch(command: FeedbackControllerCommand): Promise<void>;
}

export type FeedbackControllerWriteInput =
  | { type: "submit"; title: string; body: string }
  | { type: "reply"; threadId: string; body: string }
  | { type: "revise"; threadId: string; messageId: string; expectedRevisionId: string; body: string }
  | { type: "upload-attachment"; threadId: string; messageId?: string; purpose?: "evidence" | "conversation" };

export type FeedbackControllerWriteCommand = Extract<FeedbackControllerCommand,
  { type: "submit" | "reply" | "revise" | "upload-attachment" }>;

export type FeedbackCapturedEvidence = {
  readonly filename: string;
  readonly contentType: string;
  readonly contentHash: string;
  readonly source: FeedbackUploadSource;
};

/** frozen controller契約を変えずbrowser compositionに必要な生成機能だけを公開する実装port。 */
export interface FeedbackBrowserControllerPort extends FeedbackControllerPort {
  createWriteCommand(input: FeedbackControllerWriteInput): Promise<FeedbackControllerWriteCommand>;
  getCapturedEvidence(): FeedbackCapturedEvidence | null;
}

export interface FeedbackControllerStatePort {
  load(profileId: string): Promise<FeedbackControllerLocalState | null>;
  save(profileId: string, state: FeedbackControllerLocalState): Promise<void>;
}

/** Phase 2のstate portを変更せずpending recoveryを端末内へ保存する任意実装port。 */
export interface FeedbackControllerPendingStatePort {
  loadPendingIntents(profileId: string): Promise<readonly FeedbackPendingIntentSnapshot[]>;
  savePendingIntents(profileId: string, pendingIntents: readonly FeedbackPendingIntentSnapshot[]): Promise<void>;
}

export interface FeedbackEvidenceCapturePort {
  capture(): Promise<FeedbackCapturedEvidence>;
  cancel(): void;
}

export interface FeedbackRequestHashPort {
  calculate(value: unknown): Promise<string>;
}

export interface FeedbackControllerClock {
  now(): Date;
}

export interface FeedbackControllerScheduler {
  schedule(delayMilliseconds: number, task: () => void): () => void;
}

export interface FeedbackControllerVisibilityPort {
  isVisible(): boolean;
  subscribe(listener: (visible: boolean) => void): () => void;
}

export interface FeedbackControllerNavigationPort {
  request(input: {
    requestId: string;
    path: string;
    threadId: string;
    scope: FeedbackScopedQuery;
  }): Promise<{ locationMatches: boolean }>;
}

export interface FeedbackControllerDependencies {
  client: FeedbackClientPort;
  state: FeedbackControllerStatePort;
  capture: FeedbackEvidenceCapturePort;
  clock: FeedbackControllerClock;
  scheduler: FeedbackControllerScheduler;
  createId(): string;
}

/** frozen dependency contractへbrowser runtime固有portだけを追加する実装用composition型。 */
export interface FeedbackControllerRuntimeDependencies extends FeedbackControllerDependencies {
  visibility?: FeedbackControllerVisibilityPort;
  navigation?: FeedbackControllerNavigationPort;
  requestHash?: FeedbackRequestHashPort;
  pollingIntervalMilliseconds?: number;
}

export {
  createBrowserFeedbackControllerState,
  createMemoryFeedbackControllerState,
  feedbackClientStateV2Key,
  type FeedbackBrowserStorage,
  type FeedbackBrowserControllerStateOptions
} from "./state.js";
export { createFeedbackController } from "./controller.js";
