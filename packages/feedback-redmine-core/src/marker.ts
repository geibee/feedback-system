export type FeedbackMetadataV1 = {
  threadId: string;
  intentId: string;
  requestHash: string;
  applicationKey: string;
  environmentKey: string;
  externalWorkspaceKey: string;
  pageKey: string;
  hostResourceKey: string;
  perspectiveCode: string;
  submittedById: string;
  submittedByName?: string | null;
  messageId?: string;
  participantId?: string;
  messageSignature?: string;
  capturedAt: string;
};

export type FeedbackMessageMetadataV1 = {
  kind: "reply" | "edit";
  messageId: string;
  participantId: string;
  participantName: string | null;
  version: number;
  intentId: string;
  signature: string;
};

const marker = "---\nFeedback metadata v1\n";
const linkMarker = "---\nアプリでこのフィードバックを開く\n";

export function buildRedmineDescription(comment: string, threadUrl: string | null = null): string {
  const body = comment.replace(/\r\n?/gu, "\n").trim();
  return threadUrl ? `${body}\n\n${linkMarker}${markdownLink(threadUrl)}` : body;
}

function markdownLink(url: string): string {
  const label = url.replace(/([\\[\]])/gu, "\\$1");
  const destination = url.replace(/\\/gu, "%5C").replace(/\(/gu, "%28").replace(/\)/gu, "%29");
  return `[${label}](${destination})`;
}

const messageMarker = "---\nFeedback message v1\n";

export function buildRedmineMessageNote(body: string, metadata: FeedbackMessageMetadataV1): string {
  const normalizedBody = body.replace(/\r\n?/gu, "\n").trim();
  return `${normalizedBody}\n\n${messageMarker}${JSON.stringify(metadata)}`;
}

export function parseRedmineMessageNote(notes: string): {
  body: string;
  metadata: FeedbackMessageMetadataV1;
} | null {
  const normalized = notes.replace(/\r\n?/gu, "\n");
  const index = normalized.lastIndexOf(`\n\n${messageMarker}`);
  if (index < 0) return null;
  try {
    const value = JSON.parse(normalized.slice(index + messageMarker.length + 2)) as Record<string, unknown>;
    if ((value.kind !== "reply" && value.kind !== "edit") ||
      !uuidPattern.test(String(value.messageId)) || !uuidPattern.test(String(value.participantId)) ||
      !uuidPattern.test(String(value.intentId)) || !Number.isInteger(value.version) || (value.version as number) < 1 ||
      (value.participantName !== null && (typeof value.participantName !== "string" || value.participantName.length > 100)) ||
      typeof value.signature !== "string" || !value.signature || value.signature.length > 512) return null;
    return {
      body: normalized.slice(0, index).trim(),
      metadata: value as FeedbackMessageMetadataV1
    };
  } catch {
    return null;
  }
}

export function initialCommentFromDescription(description: string): string {
  const normalized = description.replace(/\r\n?/gu, "\n");
  const index = descriptionSuffixIndex(normalized);
  return (index < 0 ? normalized : normalized.slice(0, index)).trim();
}

export function replaceInitialCommentInDescription(description: string, comment: string): string {
  const normalized = description.replace(/\r\n?/gu, "\n");
  const index = descriptionSuffixIndex(normalized);
  if (index < 0) return comment.replace(/\r\n?/gu, "\n").trim();
  return `${comment.replace(/\r\n?/gu, "\n").trim()}${normalized.slice(index)}`;
}

export function parseFeedbackMetadata(description: string): Partial<FeedbackMetadataV1> | null {
  const normalized = description.replace(/\r\n?/gu, "\n");
  const index = normalized.lastIndexOf(`\n\n${marker}`);
  if (index < 0) return null;
  const entries = new Map(
    normalized
      .slice(index + marker.length + 2)
      .split("\n")
      .map((line) => {
        const separator = line.indexOf(": ");
        return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 2)];
      })
  );
  return {
    threadId: entries.get("Thread ID"),
    intentId: entries.get("Intent ID"),
    requestHash: entries.get("Request hash"),
    applicationKey: entries.get("Application"),
    environmentKey: entries.get("Environment"),
    externalWorkspaceKey: entries.get("External workspace"),
    pageKey: entries.get("Page"),
    hostResourceKey: entries.get("Host resource"),
    perspectiveCode: entries.get("Perspective"),
    submittedById: entries.get("Submitted by ID"),
    submittedByName: entries.get("Submitted by name"),
    messageId: entries.get("Message ID"),
    participantId: entries.get("Participant ID"),
    messageSignature: entries.get("Message signature"),
    capturedAt: entries.get("Captured at")
  };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function descriptionSuffixIndex(description: string): number {
  const legacy = description.lastIndexOf(`\n\n${marker}`);
  const link = description.lastIndexOf(`\n\n${linkMarker}`);
  return Math.max(legacy, link);
}
