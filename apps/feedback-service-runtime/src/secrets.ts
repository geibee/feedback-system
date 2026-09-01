import { createHmac } from "node:crypto";
import type { FeedbackAuthorizationDecision } from "@geibee/feedback-gateway";
import type { FeedbackSecretResolver } from "@geibee/feedback-service";
import { createFeedbackEnvelopeCodec, type FeedbackEnvelopeCodecPort, type FeedbackHmacKey } from "@geibee/feedback-envelope";

const subjectParticipantDomain = "feedback-authorization-subject-participant-id\n2\n";

export async function loadFeedbackEnvelopeCodec(
  secretResolver: FeedbackSecretResolver,
  secretId: string
): Promise<FeedbackEnvelopeCodecPort> {
  const source = await secretResolver.resolve(secretId);
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error("Envelope key ring secretが不正です"); }
  const root = exactObject(value, ["activeKid", "keys"], "Envelope key ring");
  if (typeof root.activeKid !== "string" || !Array.isArray(root.keys) || root.keys.length === 0 || root.keys.length > 8) {
    throw new Error("Envelope key ring secretが不正です");
  }
  const ids = new Set<string>();
  const keys: FeedbackHmacKey[] = root.keys.map((entry) => {
    const key = exactObject(entry, ["kid", "key"], "Envelope key");
    if (typeof key.kid !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(key.kid) || ids.has(key.kid)) {
      throw new Error("Envelope key kidが不正または重複しています");
    }
    ids.add(key.kid);
    return {
      kid: key.kid,
      secret: decodeSecretKey(key.key, "Envelope key"),
      state: key.kid === root.activeKid ? "active" : "verify-only"
    };
  });
  if (!ids.has(root.activeKid)) throw new Error("Envelope activeKidがkeysにありません");
  return createFeedbackEnvelopeCodec(keys);
}

export async function resolveProviderAuthorization(input: {
  secretResolver: FeedbackSecretResolver;
  secretId: string;
  connectorKey: "jira-cloud" | "redmine";
}): Promise<string> {
  const source = await input.secretResolver.resolve(input.secretId);
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error("provider credential secretが不正です"); }
  if (input.connectorKey === "jira-cloud") {
    const credential = exactObject(value, ["kind", "email", "apiToken"], "Jira Cloud credential");
    if (credential.kind !== "jira-cloud-basic") throw new Error("Jira Cloud credential kindが不正です");
    bounded(credential.email, "Jira Cloud email", 3, 320);
    bounded(credential.apiToken, "Jira Cloud API token", 1, 4096);
    return `Basic ${Buffer.from(`${credential.email}:${credential.apiToken}`, "utf8").toString("base64")}`;
  }
  const credential = exactObject(value, ["kind", "apiKey"], "Redmine credential");
  if (credential.kind !== "redmine-api-key") throw new Error("Redmine credential kindが不正です");
  bounded(credential.apiKey, "Redmine API key", 1, 4096);
  return credential.apiKey;
}

export async function participantIdForAuthorization(input: {
  decision: FeedbackAuthorizationDecision;
  publicParticipantId: string | null;
  profileId: string;
  derivationSecretId: string;
  secretResolver: FeedbackSecretResolver;
}): Promise<string> {
  if (input.decision.mode === "public-profile") {
    return input.publicParticipantId ?? "00000000-0000-4000-8000-000000000000";
  }
  const subjectId = input.decision.subjectId;
  if (!subjectId || subjectId.length > 1024 || subjectId.includes("\n")) {
    throw new Error("認可済みsubject IDがありません");
  }
  const key = decodeSecretKey(await input.secretResolver.resolve(input.derivationSecretId), "participant ID derivation key");
  const digest = createHmac("sha256", key)
    .update(`${subjectParticipantDomain}${input.profileId}\n${input.decision.mode}\n${subjectId}`, "utf8")
    .digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function decodeSecretKey(value: unknown, name: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error(`${name}がbase64urlではありません`);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value || bytes.byteLength < 32) throw new Error(`${name}は32 bytes以上が必要です`);
  return bytes;
}

function exactObject(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name}がobjectではありません`);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== keys.length || keys.some((key) => !(key in object))) throw new Error(`${name}のfieldが不正です`);
  return object;
}

function bounded(value: unknown, name: string, minimum: number, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) throw new Error(`${name}が不正です`);
}
