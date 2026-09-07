import { createHmac, timingSafeEqual } from "node:crypto";
import type { FeedbackThreadV2 } from "@geibee/feedback-contracts/v2";
import type { FeedbackProviderProfileV2 } from "@geibee/feedback-contracts/v2/server";
import {
  canonicalizeFeedbackJson,
  deriveFeedbackParticipantId,
  feedbackParticipantCredentialDomainSeparator
} from "@geibee/feedback-envelope";
import { FeedbackGatewayProblem } from "@geibee/feedback-gateway";
import type { FeedbackSecretResolver } from "./configuration.js";

export type FeedbackParticipantPrincipal = {
  participantId: string;
  browserProfileId: string;
  profileId: string;
  origin: string;
};

type ParticipantCredentialPayload = FeedbackParticipantPrincipal & {
  schemaVersion: "2";
  issuedAt: string;
  expiresAt: string;
};

type ParticipantKeyRing = {
  activeKid: string;
  keys: ReadonlyMap<string, Uint8Array>;
};

export async function issueFeedbackParticipantCredential(input: {
  profile: FeedbackProviderProfileV2;
  browserProfileId: string;
  origin: string;
  secretResolver: FeedbackSecretResolver;
  now?: () => Date;
}): Promise<{ participantId: string; credential: string }> {
  assertUuid(input.browserProfileId, "browser profile ID");
  const origin = normalizeOrigin(input.origin);
  const [ringSource, derivationSource] = await Promise.all([
    input.secretResolver.resolve(input.profile.secretRefs.participantCredentialKeyRing.id),
    input.secretResolver.resolve(input.profile.secretRefs.participantIdDerivationKey.id)
  ]).catch(() => { throw unavailableCredentialKeys(); });
  const ring = parseKeyRing(ringSource);
  const derivationKey = parseKeyMaterial(derivationSource, "participant ID derivation key");
  const participantId = deriveParticipantId(derivationKey, input.profile.profileId, origin, input.browserProfileId);
  const issuedAt = (input.now ?? (() => new Date()))();
  const expiresAt = new Date(issuedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
  const payload: ParticipantCredentialPayload = {
    schemaVersion: "2",
    participantId,
    browserProfileId: input.browserProfileId,
    profileId: input.profile.profileId,
    origin,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString()
  };
  const canonicalPayload = canonicalizeFeedbackJson(payload);
  const encoded = Buffer.from(canonicalPayload, "utf8").toString("base64url");
  const signature = sign(ring.keys.get(ring.activeKid)!, canonicalPayload);
  return { participantId, credential: `v2.${ring.activeKid}.${encoded}.${signature}` };
}

export async function verifyFeedbackParticipantCredential(input: {
  profile: FeedbackProviderProfileV2;
  credential: string;
  origin: string;
  secretResolver: FeedbackSecretResolver;
  now?: () => Date;
}): Promise<FeedbackParticipantPrincipal> {
  if (input.credential.length === 0 || input.credential.length > 8192) throw invalidCredential();
  const parts = input.credential.split(".");
  if (parts.length !== 4 || parts[0] !== "v2") throw invalidCredential();
  const [, kid, encoded, encodedSignature] = parts as [string, string, string, string];
  const [ringSource, derivationSource] = await Promise.all([
    input.secretResolver.resolve(input.profile.secretRefs.participantCredentialKeyRing.id),
    input.secretResolver.resolve(input.profile.secretRefs.participantIdDerivationKey.id)
  ]).catch(() => { throw unavailableCredentialKeys(); });
  const ring = parseKeyRing(ringSource);
  const key = ring.keys.get(kid);
  if (!key) throw invalidCredential();
  let payload: ParticipantCredentialPayload;
  let canonicalPayload: string;
  try {
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded) throw new Error("non-canonical base64url");
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded)) as ParticipantCredentialPayload;
    canonicalPayload = canonicalizeFeedbackJson(payload);
    if (Buffer.from(canonicalPayload, "utf8").toString("base64url") !== encoded) throw new Error("non-canonical payload");
  } catch {
    throw invalidCredential();
  }
  if (!exactPayload(payload)) throw invalidCredential();
  const expected = Buffer.from(sign(key, canonicalPayload), "ascii");
  const actual = Buffer.from(encodedSignature, "ascii");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw invalidCredential();
  const origin = normalizeOrigin(input.origin);
  const derivationKey = parseKeyMaterial(derivationSource, "participant ID derivation key");
  const expectedParticipantId = deriveParticipantId(
    derivationKey,
    input.profile.profileId,
    origin,
    payload.browserProfileId
  );
  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  const now = (input.now ?? (() => new Date()))().getTime();
  const maximumLifetimeMilliseconds = 30 * 24 * 60 * 60 * 1000;
  const clockSkewMilliseconds = 30 * 1000;
  if (payload.schemaVersion !== "2" || payload.profileId !== input.profile.profileId || payload.origin !== origin ||
      payload.participantId !== expectedParticipantId || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || !Number.isFinite(now) ||
      expiresAt <= issuedAt || expiresAt - issuedAt > maximumLifetimeMilliseconds ||
      issuedAt > now + clockSkewMilliseconds || now > expiresAt + clockSkewMilliseconds) {
    throw invalidCredential();
  }
  return {
    participantId: payload.participantId,
    browserProfileId: payload.browserProfileId,
    profileId: payload.profileId,
    origin: payload.origin
  };
}

export function assertParticipantOwnsMessage(input: {
  thread: FeedbackThreadV2;
  messageId: string;
  participantId: string;
}): void {
  const message = input.thread.messages.find((candidate) => candidate.messageId === input.messageId);
  if (!message || message.author.kind !== "participant" ||
      message.author.participantId !== input.participantId || message.author.isCurrentParticipant !== true) {
    throw new FeedbackGatewayProblem({
      code: "feedback.forbidden",
      status: 403,
      message: "messageのparticipant所有情報を確認できません"
    });
  }
}

export function assertCurrentParticipantOwnsMessage(input: {
  thread: FeedbackThreadV2;
  messageId: string;
}): void {
  const message = input.thread.messages.find((candidate) => candidate.messageId === input.messageId);
  if (!message || message.author.kind !== "participant" || message.author.isCurrentParticipant !== true) {
    throw new FeedbackGatewayProblem({
      code: "feedback.forbidden",
      status: 403,
      message: "messageの現在participant所有情報を確認できません"
    });
  }
}

function parseKeyRing(source: string): ParticipantKeyRing {
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw unavailableCredentialKeys(); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw unavailableCredentialKeys();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== 2 || typeof object.activeKid !== "string" ||
      !Array.isArray(object.keys) || object.keys.length === 0 || object.keys.length > 8) throw unavailableCredentialKeys();
  const keys = new Map<string, Uint8Array>();
  for (const entry of object.keys) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw unavailableCredentialKeys();
    const key = entry as Record<string, unknown>;
    if (Object.keys(key).length !== 2 || typeof key.kid !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(key.kid) ||
        typeof key.key !== "string" || keys.has(key.kid)) throw unavailableCredentialKeys();
    keys.set(key.kid, parseKeyMaterial(key.key, "participant credential key"));
  }
  if (!keys.has(object.activeKid)) throw unavailableCredentialKeys();
  return { activeKid: object.activeKid, keys };
}

function parseKeyMaterial(source: string, name: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(source)) throw unavailableCredentialKeys();
  const bytes = Buffer.from(source, "base64url");
  if (bytes.toString("base64url") !== source || bytes.byteLength < 32) {
    throw new FeedbackGatewayProblem({ code: "feedback.authorization_unavailable", status: 503, message: `${name}を解決できません` });
  }
  return bytes;
}

function deriveParticipantId(key: Uint8Array, profileId: string, origin: string, browserProfileId: string): string {
  return deriveFeedbackParticipantId(key, { profileId, origin, browserProfileId });
}

function sign(key: Uint8Array, canonicalPayload: string): string {
  return createHmac("sha256", key)
    .update(feedbackParticipantCredentialDomainSeparator + canonicalPayload, "utf8")
    .digest("base64url");
}

function normalizeOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw invalidCredential(); }
  if (url.origin !== value || !new Set(["https:", "http:"]).has(url.protocol) || url.username || url.password) throw invalidCredential();
  return url.origin;
}

function exactPayload(value: unknown): value is ParticipantCredentialPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const keys = ["schemaVersion", "participantId", "browserProfileId", "profileId", "origin", "issuedAt", "expiresAt"];
  return Object.keys(payload).length === keys.length && keys.every((key) => key in payload) &&
    payload.schemaVersion === "2" && typeof payload.participantId === "string" && assertUuidValue(payload.participantId) &&
    typeof payload.browserProfileId === "string" && assertUuidValue(payload.browserProfileId) &&
    typeof payload.profileId === "string" && typeof payload.origin === "string" &&
    typeof payload.issuedAt === "string" && typeof payload.expiresAt === "string";
}

function assertUuid(value: string, name: string): void {
  if (!assertUuidValue(value)) throw new FeedbackGatewayProblem({ code: "feedback.invalid_request", status: 400, message: `${name}がUUIDではありません` });
}

function assertUuidValue(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function invalidCredential(): FeedbackGatewayProblem {
  return new FeedbackGatewayProblem({ code: "feedback.forbidden", status: 403, message: "participant credentialが不正です" });
}

function unavailableCredentialKeys(): FeedbackGatewayProblem {
  return new FeedbackGatewayProblem({ code: "feedback.authorization_unavailable", status: 503, message: "participant credential key ringを解決できません" });
}
