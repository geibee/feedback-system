import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { FeedbackGatewayProblem } from "@geibee/feedback-gateway";
import type { FeedbackThreadReferencePort } from "@geibee/feedback-gateway";
import type { FeedbackSecretResolver } from "./configuration.js";

const lifetimeSeconds = 30 * 24 * 60 * 60;
const keyIdPattern = /^[A-Za-z0-9_-]{1,64}$/u;
type KeyRing = { activeKid: string; keys: { kid: string; key: string }[] };

/** 参照用の独立したAES-256鍵。Envelope／participant鍵を流用しない。 */
export function parseThreadReferenceKeyRing(source: string): KeyRing {
  if (source.length > 16384) throw new Error("参照鍵ringが大きすぎます");
  const ring = JSON.parse(source) as KeyRing;
  if (!ring || Object.keys(ring).sort().join(",") !== "activeKid,keys" ||
      typeof ring.activeKid !== "string" || !keyIdPattern.test(ring.activeKid) || !Array.isArray(ring.keys) ||
      ring.keys.length < 1 || ring.keys.length > 8 ||
      ring.keys.some((entry) => !entry || Object.keys(entry).sort().join(",") !== "key,kid" ||
        typeof entry.kid !== "string" || !keyIdPattern.test(entry.kid) || typeof entry.key !== "string" ||
        decode(entry.key).length !== 32) ||
      new Set(ring.keys.map((entry) => entry.kid)).size !== ring.keys.length ||
      ring.keys.filter((entry) => entry.kid === ring.activeKid).length !== 1) {
    throw new Error("参照鍵ringが不正です");
  }
  return ring;
}

function decode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("参照encodingが不正です");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new Error("参照encodingが非正規です");
  return bytes;
}

export function createThreadReferencePort(input: {
  secretResolver: FeedbackSecretResolver;
  audience: string;
  now?: () => number;
}): FeedbackThreadReferencePort {
  const now = () => Math.floor((input.now?.() ?? Date.now()) / 1000);
  const binding = (scope: Parameters<FeedbackThreadReferencePort["seal"]>[1]) =>
    [input.audience, scope.profileId, scope.installationId, scope.workspaceId, scope.resource.kind, scope.resource.key, scope.threadId];
  const ringFor = async (profile: Parameters<FeedbackThreadReferencePort["seal"]>[0]) => {
    const ref = profile.secretRefs.threadReferenceKeyRing;
    return ref ? parseThreadReferenceKeyRing(await input.secretResolver.resolve(ref.id)) : undefined;
  };
  return {
    async seal(profile, scope, reference) {
      const ring = await ringFor(profile);
      if (!ring) return undefined;
      if (reference.providerKey !== profile.connectorKey || !reference.objectId || reference.objectId.length > 512) {
        throw new Error("参照のprovider bindingが不正です");
      }
      const key = ring.keys.find((entry) => entry.kid === ring.activeKid)!;
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", decode(key.key), iv, { authTagLength: 16 });
      cipher.setAAD(Buffer.from(JSON.stringify(["feedback-thread-reference", 1, key.kid, ...binding(scope)])));
      const issuedAt = now();
      const plaintext = JSON.stringify({ providerKey: reference.providerKey, objectId: reference.objectId, issuedAt, expiresAt: issuedAt + lifetimeSeconds });
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return ["ftr1", key.kid, iv.toString("base64url"), ciphertext.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
    },
    async open(profile, scope, token) {
      try {
        if (token.length > 8192) throw new Error();
        const parts = token.split(".");
        if (parts.length !== 5 || parts[0] !== "ftr1" || !keyIdPattern.test(parts[1]!)) throw new Error();
        const ring = await ringFor(profile);
        const key = ring?.keys.find((entry) => entry.kid === parts[1]);
        if (!key) throw new Error();
        const iv = decode(parts[2]!);
        const tag = decode(parts[4]!);
        if (iv.length !== 12 || tag.length !== 16) throw new Error();
        const decipher = createDecipheriv("aes-256-gcm", decode(key.key), iv, { authTagLength: 16 });
        decipher.setAAD(Buffer.from(JSON.stringify(["feedback-thread-reference", 1, key.kid, ...binding(scope)])));
        decipher.setAuthTag(tag);
        const value = JSON.parse(Buffer.concat([decipher.update(decode(parts[3]!)), decipher.final()]).toString("utf8")) as Record<string, unknown>;
        if (Object.keys(value).sort().join(",") !== "expiresAt,issuedAt,objectId,providerKey" ||
            value.providerKey !== profile.connectorKey || typeof value.objectId !== "string" ||
            !value.objectId || value.objectId.length > 512 ||
            !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt) ||
            (value.issuedAt as number) > now() || (value.expiresAt as number) <= now() ||
            (value.expiresAt as number) - (value.issuedAt as number) !== lifetimeSeconds) throw new Error();
        return { providerKey: profile.connectorKey, objectId: value.objectId };
      } catch {
        throw new FeedbackGatewayProblem({ code: "feedback.integrity_error", status: 409, message: "thread参照が不正または失効しています。検索への自動切替はできません" });
      }
    }
  };
}
