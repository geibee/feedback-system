import type { FeedbackAttachmentMarkerV2, FeedbackMessageMarkerV2 } from "@geibee/feedback-contracts/v2/server";

const v1Marker = "---\nFeedback message v1\n";

export type RedmineLegacyMessageMetadata = {
  kind: "reply" | "edit";
  messageId: string;
  participantId: string;
  participantName: string | null;
  version: number;
  intentId: string;
  signature: string;
  feedbackV2?: FeedbackMessageMarkerV2;
  feedbackV2Attachment?: FeedbackAttachmentMarkerV2;
};

export function buildDualWriteRedmineNote(body: string, metadata: RedmineLegacyMessageMetadata): string {
  const normalized = normalizeBody(body);
  return `${normalized}\n\n${v1Marker}${JSON.stringify(metadata)}`;
}

export function buildRedmineAttachmentMappingNote(marker: FeedbackAttachmentMarkerV2): string {
  const metadata: RedmineLegacyMessageMetadata = {
    kind: "edit",
    messageId: marker.attachmentId,
    participantId: marker.attachmentId,
    participantName: null,
    version: 1,
    intentId: marker.intentId,
    signature: marker.signature.value,
    feedbackV2Attachment: marker
  };
  return buildDualWriteRedmineNote("Feedback attachment mapping", metadata);
}

export function parseRedmineMessageNote(notes: unknown): {
  body: string;
  metadata: RedmineLegacyMessageMetadata;
} | null {
  if (typeof notes !== "string") return null;
  const normalized = notes.replace(/\r\n?/gu, "\n");
  const index = normalized.lastIndexOf(`\n\n${v1Marker}`);
  if (index < 0) return null;
  try {
    const value = JSON.parse(normalized.slice(index + v1Marker.length + 2)) as Record<string, unknown>;
    if ((value.kind !== "reply" && value.kind !== "edit") || typeof value.messageId !== "string" ||
      typeof value.participantId !== "string" || typeof value.intentId !== "string" ||
      !Number.isInteger(value.version) || Number(value.version) < 1 || typeof value.signature !== "string") return null;
    if (value.participantName !== null && typeof value.participantName !== "string") return null;
    return { body: normalized.slice(0, index).trim(), metadata: value as RedmineLegacyMessageMetadata };
  } catch {
    return null;
  }
}

export function normalizeBody(body: string): string {
  const normalized = body.replace(/\r\n?/gu, "\n").trim();
  if (!normalized) throw new Error("Redmine message本文が空です");
  return normalized;
}
