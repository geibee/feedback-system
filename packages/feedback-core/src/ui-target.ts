import type { FeedbackTargetV1 } from "@feedback/contracts";

export type FeedbackTargetResolverInput<TElement = unknown> = {
  action: "pick" | "context-menu";
  element: TElement | null;
  clientX: number;
  clientY: number;
};

export type FeedbackTargetResolver<TElement = unknown> = (
  input: FeedbackTargetResolverInput<TElement>
) => FeedbackTargetV1 | null;

export type FeedbackPinPosition = { x: number; y: number };

export type FeedbackPinPositionProvider = {
  getPosition(target: FeedbackTargetV1): FeedbackPinPosition | null;
  subscribe(listener: () => void): () => void;
};
