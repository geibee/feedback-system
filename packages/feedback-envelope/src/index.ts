import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  FeedbackAttachmentMarkerV2,
  FeedbackEnvelopeV2,
  FeedbackMessageMarkerV2
} from "@geibee/feedback-contracts/v2/server";

export const feedbackEnvelopeDomainSeparator = "feedback-envelope\n2\n" as const;
export const feedbackMessageMarkerDomainSeparator = "feedback-message-marker\n2\n" as const;
export const feedbackAttachmentMarkerDomainSeparator = "feedback-attachment-marker\n2\n" as const;
export const feedbackParticipantCredentialDomainSeparator = "feedback-participant-credential\n2\n" as const;
export const feedbackParticipantIdDomainSeparator = "feedback-participant-id\n2\n" as const;
export const feedbackCommandDomainSeparator = "feedback-command\n2\n" as const;

export type FeedbackKeyPurpose = "envelope" | "participant-credential" | "participant-id";

export type FeedbackSigningKeyRef = {
  kid: string;
  secretRef: string;
  state: "active" | "verify-only";
};

export interface FeedbackKeyRingPort {
  load(purpose: Exclude<FeedbackKeyPurpose, "participant-id">): Promise<readonly FeedbackSigningKeyRef[]>;
  loadParticipantIdDerivationKey(): Promise<{ secretRef: string }>;
}

export type FeedbackHmacKey = {
  kid: string;
  secret: Uint8Array;
  state: "active" | "verify-only";
};

export type FeedbackEnvelopeVerificationContext = {
  profileId: string;
  installationId: string;
  objectId: string;
};

export type FeedbackArtifactVerification<T> =
  | { valid: true; value: T }
  | { valid: false; reason: "schema" | "canonicalization" | "unknown_kid" | "signature" | "binding" };

export type FeedbackEnvelopeVerification =
  | { valid: true; value: FeedbackEnvelopeV2; envelope: FeedbackEnvelopeV2 }
  | { valid: false; reason: "schema" | "canonicalization" | "unknown_kid" | "signature" | "binding" };

export type FeedbackMessageMarkerPayload = Pick<FeedbackMessageMarkerV2,
  "schemaVersion" | "threadId" | "eventId" | "eventKind" | "messageId" | "expectedRevisionId" |
  "intentId" | "requestHash" | "participantId" | "bodyHash" | "providerBinding" | "createdAt">;

export interface FeedbackEnvelopeCodecPort {
  signEnvelope(payload: Omit<FeedbackEnvelopeV2, "signature">): Promise<FeedbackEnvelopeV2>;
  verifyEnvelope(value: unknown, context: FeedbackEnvelopeVerificationContext): Promise<FeedbackEnvelopeVerification>;
  signMessageMarker(payload: FeedbackMessageMarkerPayload): Promise<FeedbackMessageMarkerV2>;
  verifyMessageMarker(value: unknown, context: FeedbackEnvelopeVerificationContext): Promise<FeedbackArtifactVerification<FeedbackMessageMarkerV2>>;
  signAttachmentMarker(payload: Omit<FeedbackAttachmentMarkerV2, "signature">): Promise<FeedbackAttachmentMarkerV2>;
  verifyAttachmentMarker(value: unknown, context: FeedbackEnvelopeVerificationContext): Promise<FeedbackArtifactVerification<FeedbackAttachmentMarkerV2>>;
}

export function canonicalizeFeedbackJson(value: unknown): string {
  return canonicalize(value, new Set<object>());
}

export function calculateFeedbackCommandHash(value: unknown): string {
  const canonical = canonicalizeFeedbackJson(value);
  return `sha256:${createHash("sha256").update(feedbackCommandDomainSeparator + canonical, "utf8").digest("hex")}`;
}

export function deriveFeedbackParticipantId(
  key: Uint8Array,
  input: { profileId: string; origin: string; browserProfileId: string }
): string {
  if (key.byteLength < 32) throw new Error("participant ID導出keyは32 bytes以上が必要です");
  for (const value of [input.profileId, input.origin, input.browserProfileId]) {
    if (value.length === 0 || value.includes("\n")) throw new Error("participant ID導出inputが不正です");
  }
  const digest = createHmac("sha256", key)
    .update(`${feedbackParticipantIdDomainSeparator}${input.profileId}\n${input.origin}\n${input.browserProfileId}`, "utf8")
    .digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createFeedbackEnvelopeCodec(keys: readonly FeedbackHmacKey[]): FeedbackEnvelopeCodecPort {
  const keyById = new Map<string, Uint8Array>();
  let active: FeedbackHmacKey | undefined;
  for (const key of keys) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(key.kid)) throw new Error(`不正なkidです: ${key.kid}`);
    if (keyById.has(key.kid)) throw new Error(`kidが重複しています: ${key.kid}`);
    if (key.secret.byteLength < 32) throw new Error(`HMAC keyは32 bytes以上が必要です: ${key.kid}`);
    const copy = Uint8Array.from(key.secret);
    keyById.set(key.kid, copy);
    if (key.state === "active") {
      if (active) throw new Error("active Envelope signing keyは一つだけ必要です");
      active = { ...key, secret: copy };
    }
  }
  if (!active) throw new Error("active Envelope signing keyがありません");
  const activeKey = active;

  const sign = <T extends object>(payload: T, domain: string): T & { signature: FeedbackEnvelopeV2["signature"] } => ({
    ...payload,
    signature: {
      alg: "HS256",
      kid: activeKey.kid,
      value: signatureValue(domain, payload, activeKey.secret)
    }
  });

  const verify = <T>(
    value: unknown,
    context: FeedbackEnvelopeVerificationContext,
    domain: string,
    validate: (candidate: unknown) => candidate is T
  ): FeedbackArtifactVerification<T> => {
    if (!validate(value)) return { valid: false, reason: "schema" };
    const signed = value as T & { signature: FeedbackEnvelopeV2["signature"]; providerBinding: FeedbackEnvelopeV2["providerBinding"] };
    const key = keyById.get(signed.signature.kid);
    if (!key) return { valid: false, reason: "unknown_kid" };
    const { signature: artifactSignature, ...payload } = signed;
    let expected: string;
    try {
      expected = signatureValue(domain, payload, key);
    } catch {
      return { valid: false, reason: "canonicalization" };
    }
    const actualBytes = Buffer.from(artifactSignature.value, "base64url");
    const expectedBytes = Buffer.from(expected, "base64url");
    if (actualBytes.byteLength !== expectedBytes.byteLength || !timingSafeEqual(actualBytes, expectedBytes)) {
      return { valid: false, reason: "signature" };
    }
    if (signed.providerBinding.profileId !== context.profileId ||
      signed.providerBinding.installationId !== context.installationId ||
      signed.providerBinding.objectId !== context.objectId) {
      return { valid: false, reason: "binding" };
    }
    return { valid: true, value };
  };

  const codec: FeedbackEnvelopeCodecPort = {
    async signEnvelope(payload) {
      if (!isEnvelopePayload(payload)) throw new Error("Envelope payloadがschema契約と一致しません");
      return sign(payload, feedbackEnvelopeDomainSeparator);
    },
    async verifyEnvelope(value, context) {
      const result = verify(value, context, feedbackEnvelopeDomainSeparator, isEnvelope);
      return result.valid ? { valid: true, value: result.value, envelope: result.value } : result;
    },
    async signMessageMarker(payload) {
      if (!isMessageMarkerPayload(payload)) throw new Error("message marker payloadがschema契約と一致しません");
      return sign(payload, feedbackMessageMarkerDomainSeparator) as FeedbackMessageMarkerV2;
    },
    async verifyMessageMarker(value, context) {
      return verify(value, context, feedbackMessageMarkerDomainSeparator, isMessageMarker);
    },
    async signAttachmentMarker(payload) {
      if (!isAttachmentMarkerPayload(payload)) throw new Error("attachment marker payloadがschema契約と一致しません");
      return sign(payload, feedbackAttachmentMarkerDomainSeparator);
    },
    async verifyAttachmentMarker(value, context) {
      return verify(value, context, feedbackAttachmentMarkerDomainSeparator, isAttachmentMarker);
    }
  };
  return Object.freeze(codec);
}

function signatureValue(domain: string, payload: unknown, key: Uint8Array): string {
  return createHmac("sha256", key).update(domain + canonicalizeFeedbackJson(payload), "utf8").digest("base64url");
}

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSONはfinite numberだけを受けます");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("canonical JSONに非JSON値があります");
  if (ancestors.has(value)) throw new TypeError("canonical JSONに循環参照があります");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key) => !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length)) {
        throw new TypeError("canonical JSON arrayに追加propertyがあります");
      }
      return `[${value.map((item) => canonicalize(item, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("canonical JSONはplain objectだけを受けます");
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    return `{${keys.map((key) => {
      assertUnicodeScalarString(key);
      return `${JSON.stringify(key)}:${canonicalize(object[key], ancestors)}`;
    }).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("lone high surrogateはcanonicalizeできません");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("lone low surrogateはcanonicalizeできません");
    }
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const hash = /^sha256:[a-f0-9]{64}$/u;
const signature = /^[A-Za-z0-9_-]{43}$/u;
const stableKey = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const dateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function validBinding(value: unknown): value is FeedbackEnvelopeV2["providerBinding"] {
  return record(value) && exactKeys(value, ["profileId", "installationId", "objectId"]) &&
    typeof value.profileId === "string" && stableKey.test(value.profileId) &&
    [value.installationId, value.objectId].every((item) => typeof item === "string" && item.length > 0 && item.length <= 500);
}

function validSignature(value: unknown): value is FeedbackEnvelopeV2["signature"] {
  return record(value) && exactKeys(value, ["alg", "kid", "value"]) && value.alg === "HS256" &&
    typeof value.kid === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value.kid) &&
    typeof value.value === "string" && signature.test(value.value);
}

function isEnvelopePayload(value: unknown): value is Omit<FeedbackEnvelopeV2, "signature"> {
  if (!record(value) || !exactKeys(value,
    ["schemaVersion", "threadId", "intentId", "requestHash", "providerBinding", "scope", "createdBy", "createdAt"],
    ["release", "perspective", "location", "target"])) return false;
  return value.schemaVersion === "2" && typeof value.threadId === "string" && uuid.test(value.threadId) &&
    typeof value.intentId === "string" && uuid.test(value.intentId) && typeof value.requestHash === "string" && hash.test(value.requestHash) &&
    validBinding(value.providerBinding) && validStoredScope(value.scope) && validCreatedBy(value.createdBy) && validDateTime(value.createdAt) &&
    optionalString(value.release, 200) && optionalString(value.perspective, 100) &&
    (value.location === undefined || validScalarObject(value.location)) && (value.target === undefined || validTarget(value.target));
}

function isEnvelope(value: unknown): value is FeedbackEnvelopeV2 {
  if (!record(value) || !validSignature(value.signature)) return false;
  const { signature: _signature, ...payload } = value;
  return isEnvelopePayload(payload);
}

function isMessageMarkerPayload(value: unknown): value is FeedbackMessageMarkerPayload {
  if (!record(value) || !exactKeys(value,
    ["schemaVersion", "threadId", "eventId", "eventKind", "messageId", "intentId", "requestHash", "participantId", "bodyHash", "providerBinding", "createdAt"],
    ["expectedRevisionId"])) return false;
  const identifiers = [value.threadId, value.eventId, value.messageId, value.intentId, value.participantId];
  return value.schemaVersion === "2" && identifiers.every((item) => typeof item === "string" && uuid.test(item)) &&
    (value.eventKind === "reply" || value.eventKind === "revision") &&
    (value.eventKind === "revision" ? typeof value.expectedRevisionId === "string" && uuid.test(value.expectedRevisionId) : value.expectedRevisionId === undefined) &&
    typeof value.requestHash === "string" && hash.test(value.requestHash) && typeof value.bodyHash === "string" && hash.test(value.bodyHash) &&
    validBinding(value.providerBinding) && validDateTime(value.createdAt);
}

function isMessageMarker(value: unknown): value is FeedbackMessageMarkerV2 {
  if (!record(value) || !validSignature(value.signature)) return false;
  const { signature: _signature, ...payload } = value;
  return isMessageMarkerPayload(payload);
}

function isAttachmentMarkerPayload(value: unknown): value is Omit<FeedbackAttachmentMarkerV2, "signature"> {
  if (!record(value) || !exactKeys(value,
    ["schemaVersion", "threadId", "messageId", "attachmentId", "intentId", "requestHash", "providerBinding", "providerAttachmentId", "filename", "contentType", "sizeBytes", "contentHash", "createdAt"])) return false;
  const identifiers = [value.threadId, value.messageId, value.attachmentId, value.intentId];
  return value.schemaVersion === "2" && identifiers.every((item) => typeof item === "string" && uuid.test(item)) &&
    typeof value.requestHash === "string" && hash.test(value.requestHash) && validBinding(value.providerBinding) &&
    typeof value.providerAttachmentId === "string" && value.providerAttachmentId.length > 0 &&
    typeof value.filename === "string" && value.filename.length > 0 && typeof value.contentType === "string" && value.contentType.length > 0 &&
    Number.isInteger(value.sizeBytes) && Number(value.sizeBytes) > 0 && typeof value.contentHash === "string" && hash.test(value.contentHash) &&
    validDateTime(value.createdAt);
}

function isAttachmentMarker(value: unknown): value is FeedbackAttachmentMarkerV2 {
  if (!record(value) || !validSignature(value.signature)) return false;
  const { signature: _signature, ...payload } = value;
  return isAttachmentMarkerPayload(payload);
}

function validDateTime(value: unknown): value is string {
  return typeof value === "string" && dateTime.test(value) && Number.isFinite(Date.parse(value));
}

function optionalString(value: unknown, maximum: number): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0 && value.length <= maximum);
}

function validResource(value: unknown): boolean {
  return record(value) && exactKeys(value, ["kind", "key"]) && typeof value.kind === "string" && stableKey.test(value.kind) &&
    typeof value.key === "string" && value.key.length > 0 && value.key.length <= 512;
}

function validStoredScope(value: unknown): boolean {
  return record(value) && exactKeys(value, ["workspace", "resource", "application", "environment"]) &&
    [value.workspace, value.application, value.environment].every((item) => typeof item === "string" && stableKey.test(item)) &&
    validResource(value.resource);
}

function validCreatedBy(value: unknown): boolean {
  return record(value) && exactKeys(value, ["participantId"]) && typeof value.participantId === "string" && uuid.test(value.participantId);
}

function validScalarObject(value: unknown): boolean {
  if (!record(value) || Object.keys(value).length > 64) return false;
  return Object.values(value).every((item) => item === null || typeof item === "string" && item.length <= 2000 ||
    typeof item === "boolean" || typeof item === "number" && Number.isFinite(item));
}

function validTarget(value: unknown): boolean {
  return record(value) && exactKeys(value, ["kind", "targetKey"], ["provider", "metadata"]) &&
    typeof value.kind === "string" && stableKey.test(value.kind) && typeof value.targetKey === "string" &&
    value.targetKey.length > 0 && value.targetKey.length <= 500 && optionalString(value.provider, 200) &&
    (value.metadata === undefined || validScalarObject(value.metadata));
}
