import type { FeedbackLocationV1, FeedbackTargetV1 } from "@geibee/contracts";
import type { RedmineEvidenceMetadata } from "./model.js";
import { RedmineFeedbackError, contractError } from "./errors.js";

export type TrustedFeedbackAuthor = {
  source: "participant-credential";
  participantId: string;
  displayName: string | null;
};

export type RedmineFeedbackContextV1 = {
  schemaVersion: "1";
  kind: "feedback-context";
  threadId: string;
  intentId: string;
  requestHash: string;
  applicationKey: string;
  environmentKey: string;
  externalWorkspaceKey: string;
  pageKey: string;
  hostResourceKey: string;
  release: string;
  locale: string;
  threadUrl: string | null;
  perspectiveCode: string;
  location: FeedbackLocationV1;
  target: FeedbackTargetV1 | null;
  author: TrustedFeedbackAuthor;
  /** 初回投稿の自己編集権を改ざんから保護する署名。説明欄へは保存しない。 */
  initialMessageSignature: string | null;
  capturedAt: string;
  primaryEvidence: RedmineEvidenceMetadata | null;
};

export type RequestHashInput = Omit<
  RedmineFeedbackContextV1,
  "schemaVersion" | "kind" | "requestHash" | "threadUrl" | "initialMessageSignature" | "capturedAt" | "primaryEvidence"
> & {
  comment: string;
  evidenceSha256: string | null;
};

export async function calculateRequestHash(input: RequestHashInput): Promise<string> {
  return sha256Hex(utf8(canonicalJson({
    threadId: input.threadId,
    intentId: input.intentId,
    applicationKey: input.applicationKey,
    environmentKey: input.environmentKey,
    externalWorkspaceKey: input.externalWorkspaceKey,
    pageKey: input.pageKey,
    hostResourceKey: input.hostResourceKey,
    release: input.release,
    locale: input.locale,
    perspectiveCode: input.perspectiveCode,
    location: input.location,
    target: input.target,
    authorParticipantId: input.author.participantId,
    authorSource: input.author.source,
    comment: input.comment,
    evidenceSha256: input.evidenceSha256
  })));
}

export function serializeFeedbackContext(context: RedmineFeedbackContextV1): Uint8Array {
  const text = `${JSON.stringify(context, null, 2)}\n`;
  const bytes = utf8(text);
  if (bytes.byteLength > 1_048_576) {
    throw new RedmineFeedbackError("redmine.payload_too_large", "context attachmentが1 MiBを超えています");
  }
  return bytes;
}

export function buildLocator(location: FeedbackLocationV1, target: FeedbackTargetV1 | null): string {
  const value = canonicalJson({ v: "1", location, target });
  if (utf8(value).byteLength > 16_384) {
    throw new RedmineFeedbackError("feedback.locator_too_large", "Feedback locatorが16 KiBを超えています");
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw contractError("canonical JSONへ非finite numberは保存できません");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, entry]) => [key, canonicalValue(entry)])
    );
  }
  throw contractError("canonical JSONへ保存できない値です");
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
