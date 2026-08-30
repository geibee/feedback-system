import type {
  FeedbackHostContextV1,
  FeedbackLocationV1,
  FeedbackTargetV1
} from "@geibee/feedback-contracts";

export type FeedbackEvidenceRequest = {
  context: FeedbackHostContextV1;
  location: FeedbackLocationV1;
  target: FeedbackTargetV1;
  excludeSelector: string;
  maskSelector: string;
};

/** DOM や Blob を要求しない、host から transport へ渡せる証跡表現。 */
export type FeedbackEvidencePayload = {
  bytes: Uint8Array;
  contentType: "image/png" | "image/webp";
  viewportWidth: number;
  viewportHeight: number;
  pixelRatio: number;
  capturedAt: string;
};

export type FeedbackEvidenceProvider = (
  request: FeedbackEvidenceRequest
) => Promise<FeedbackEvidencePayload | null>;

export type FeedbackHostAdapter = {
  getContext(): FeedbackHostContextV1;
  getLocation(): FeedbackLocationV1 | null;
  /** context/location の変更通知。購読解除関数を返し、未実装時は初回読込だけを行う。 */
  subscribe?(listener: () => void): () => void;
  navigate(location: FeedbackLocationV1, threadId: string): void | Promise<void>;
  captureEvidence?: FeedbackEvidenceProvider;
};
