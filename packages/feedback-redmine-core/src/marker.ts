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
  submissionChannel: "embedded" | "extension";
  submittedById: string;
  capturedAt: string;
};

const marker = "---\nFeedback metadata v1\n";

export function buildRedmineDescription(comment: string, metadata: FeedbackMetadataV1): string {
  const body = comment.replace(/\r\n?/gu, "\n").trim();
  return `${body}\n\n${marker}${[
    ["Thread ID", metadata.threadId],
    ["Intent ID", metadata.intentId],
    ["Request hash", metadata.requestHash],
    ["Application", metadata.applicationKey],
    ["Environment", metadata.environmentKey],
    ["External workspace", metadata.externalWorkspaceKey],
    ["Page", metadata.pageKey],
    ["Host resource", metadata.hostResourceKey],
    ["Perspective", metadata.perspectiveCode],
    ["Submission channel", metadata.submissionChannel],
    ["Submitted by ID", metadata.submittedById],
    ["Captured at", metadata.capturedAt],
    ["Context attachment", "feedback-context-v1.json"]
  ].map(([key, value]) => `${key}: ${value}`).join("\n")}`;
}

export function initialCommentFromDescription(description: string): string {
  const normalized = description.replace(/\r\n?/gu, "\n");
  const index = normalized.lastIndexOf(`\n\n${marker}`);
  return (index < 0 ? normalized : normalized.slice(0, index)).trim();
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
  const channel = entries.get("Submission channel");
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
    submissionChannel: channel === "embedded" || channel === "extension" ? channel : undefined,
    submittedById: entries.get("Submitted by ID"),
    capturedAt: entries.get("Captured at")
  };
}
