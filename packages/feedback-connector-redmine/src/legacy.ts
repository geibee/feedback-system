import { calculateFeedbackCommandHash } from "@geibee/feedback-envelope";

export type LegacyThreadMetadata = {
  threadId: string | null;
  intentId: string | null;
  requestHash: string | null;
  applicationKey: string | null;
  environmentKey: string | null;
  workspaceId: string | null;
  resourceKey: string | null;
  participantId: string | null;
};

export function deriveRedmineStableId(kind: string, issueId: number, providerId: string | number): string {
  const hex = calculateFeedbackCommandHash({ provider: "redmine", kind, issueId, providerId }).slice("sha256:".length, "sha256:".length + 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function validStableId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

export function parseLegacyDescription(description: unknown): Partial<LegacyThreadMetadata> {
  if (typeof description !== "string") return {};
  const marker = "\n\n---\nFeedback metadata v1\n";
  const index = description.replace(/\r\n?/gu, "\n").lastIndexOf(marker);
  if (index < 0) return {};
  const entries = new Map(description.slice(index + marker.length).split("\n").map((line) => {
    const separator = line.indexOf(": ");
    return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 2)];
  }));
  return {
    threadId: text(entries.get("Thread ID")),
    intentId: text(entries.get("Intent ID")),
    requestHash: text(entries.get("Request hash")),
    applicationKey: text(entries.get("Application")),
    environmentKey: text(entries.get("Environment")),
    workspaceId: text(entries.get("External workspace")),
    resourceKey: text(entries.get("Host resource")),
    participantId: text(entries.get("Submitted by ID"))
  };
}

export function initialBodyFromDescription(description: unknown): string {
  if (typeof description !== "string") return "";
  const normalized = description.replace(/\r\n?/gu, "\n");
  const suffixes = [
    "\n\n---\nFeedback metadata v1\n",
    "\n\n---\n証跡画像\n",
    "\n\n---\nアプリでこのフィードバックを開く\n"
  ];
  const indexes = suffixes.map((value) => normalized.indexOf(value)).filter((value) => value >= 0);
  return (indexes.length === 0 ? normalized : normalized.slice(0, Math.min(...indexes))).trim();
}

function text(value: string | undefined): string | null {
  return value && value.trim() ? value.trim() : null;
}
