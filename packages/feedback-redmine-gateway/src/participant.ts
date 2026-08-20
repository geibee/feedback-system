import { GatewayHttpError } from "./problem.js";

export type ParticipantPrincipal = {
  participantId: string;
  browserProfileId: string;
  profileId: string;
  origin: string;
};

type CredentialPayload = ParticipantPrincipal & {
  v: "1";
  issuedAt: string;
};

export async function issueParticipantCredential(input: {
  browserProfileId: string;
  profileId: string;
  origin: string;
  signingKey: string | Uint8Array;
}): Promise<{ participantId: string; credential: string }> {
  assertUuid(input.browserProfileId, "browser profile ID");
  const key = signingKeyBytes(input.signingKey);
  const participantId = await deriveParticipantId(
    key,
    input.profileId,
    input.origin,
    input.browserProfileId
  );
  const payload: CredentialPayload = {
    v: "1",
    participantId,
    browserProfileId: input.browserProfileId,
    profileId: input.profileId,
    origin: input.origin,
    issuedAt: new Date().toISOString()
  };
  const encoded = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmac(key, `feedback-participant-v1\n${encoded}`);
  return { participantId: payload.participantId, credential: `${encoded}.${base64Url(signature)}` };
}

export async function requireParticipantCredential(input: {
  request: Request;
  profileId: string;
  signingKey: string | Uint8Array;
}): Promise<ParticipantPrincipal> {
  const credential = input.request.headers.get("X-Feedback-Participant-Credential") ?? "";
  const [encoded, encodedSignature, extra] = credential.split(".");
  if (!encoded || !encodedSignature || extra !== undefined) invalidCredential();
  const key = signingKeyBytes(input.signingKey);
  const actual = fromBase64Url(encodedSignature);
  const expected = await hmac(key, `feedback-participant-v1\n${encoded}`);
  if (!timingSafeEqual(actual, expected)) invalidCredential();
  let payload: CredentialPayload;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(encoded))) as CredentialPayload;
  } catch {
    invalidCredential();
  }
  const origin = new URL(input.request.url).origin;
  const participantId = await deriveParticipantId(key, input.profileId, origin, payload!.browserProfileId);
  if (payload!.v !== "1" || payload!.profileId !== input.profileId || payload!.origin !== origin ||
    payload!.participantId !== participantId || !uuidPattern.test(payload!.participantId) ||
    !uuidPattern.test(payload!.browserProfileId) ||
    !Number.isFinite(Date.parse(payload!.issuedAt))) invalidCredential();
  return {
    participantId: payload!.participantId,
    browserProfileId: payload!.browserProfileId,
    profileId: payload!.profileId,
    origin: payload!.origin
  };
}

async function deriveParticipantId(
  key: Uint8Array,
  profileId: string,
  origin: string,
  browserProfileId: string
): Promise<string> {
  const digest = await hmac(key, ["feedback-participant-id-v1", profileId, origin, browserProfileId].join("\n"));
  const bytes = Uint8Array.from(digest.slice(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function signMessageMarker(input: {
  signingKey: string | Uint8Array;
  profileId: string;
  threadId: string;
  messageId: string;
  participantId: string;
  kind: "initial" | "reply" | "edit";
  version: number;
  intentId: string;
  body: string;
}): Promise<string> {
  const bytes = await hmac(signingKeyBytes(input.signingKey), [
    "feedback-message-v1",
    input.profileId,
    input.threadId,
    input.messageId,
    input.participantId,
    input.kind,
    String(input.version),
    input.intentId,
    input.body.replace(/\r\n?/gu, "\n").trim()
  ].join("\n"));
  return base64Url(bytes);
}

export async function verifyMessageMarker(input: Parameters<typeof signMessageMarker>[0] & {
  signature: string;
}): Promise<boolean> {
  const expected = await signMessageMarker(input);
  const left = new TextEncoder().encode(input.signature);
  const right = new TextEncoder().encode(expected);
  return timingSafeEqual(left, right);
}

function signingKeyBytes(value: string | Uint8Array): Uint8Array {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : Uint8Array.from(value);
  if (bytes.byteLength < 32) {
    throw new GatewayHttpError(503, "redmine.unavailable", "participant signing keyは32 bytes以上必要です");
  }
  return bytes;
}

async function hmac(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(keyBytes).buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) invalidCredential();
  try {
    const binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (base64Url(bytes) !== value) invalidCredential();
    return bytes;
  } catch {
    invalidCredential();
  }
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

function assertUuid(value: string, name: string): void {
  if (!uuidPattern.test(value)) throw new GatewayHttpError(400, "redmine.contract_invalid", `${name}がUUIDではありません`);
}

function invalidCredential(): never {
  throw new GatewayHttpError(403, "redmine.permission_denied", "participant credentialが不正です");
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
