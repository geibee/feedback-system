import { createHmac, timingSafeEqual } from "node:crypto";
import type { FeedbackRedmineGatewayHost } from "@feedback/redmine-gateway";
import type { FeedbackHostResourceRefV1 } from "@feedback/redmine-core";

const cookieName = "feedback_redmine_demo_session";

export type SignedDemoSession = {
  schemaVersion: "1";
  subjectId: string;
  displayName: string | null;
  redmineUserId: number | null;
  profileId: string;
  canCreate: boolean;
  resources: Array<FeedbackHostResourceRefV1 & { storedResourceKey: string }>;
  csrfToken: string;
  expiresAt: number;
};

type DemoPrincipal = {
  subjectId: string;
  displayName: string | null;
  redmineUserId: number | null;
  session: SignedDemoSession;
};

/** 署名済みcookieだけを受理するtest/demo用adapter。productionでは顧客固有adapterへ差し替える。 */
export function createSignedDemoSessionAdapter(secret: string): FeedbackRedmineGatewayHost {
  if (!secret) throw new Error("session secretは必須です");
  return {
    authenticate: async (request) => {
      const token = readCookie(request.headers.get("Cookie") ?? "", cookieName);
      if (!token) return null;
      const session = verifyDemoSession(token, secret);
      return session ? { subjectId: session.subjectId, displayName: session.displayName, redmineUserId: session.redmineUserId, session } : null;
    },
    authorizeProfile: async ({ principal, operation, profileId }) => {
      const session = sessionFrom(principal);
      return session.profileId === profileId && (operation === "read" || session.canCreate);
    },
    authorizeResource: async ({ principal, profileId, resourceRef }) => {
      const session = sessionFrom(principal);
      if (session.profileId !== profileId) return null;
      const resource = session.resources.find((entry) => entry.kind === resourceRef.kind && entry.key === resourceRef.key);
      return resource ? { resourceKey: resource.storedResourceKey } : null;
    },
    authorizeStoredResource: async ({ principal, profileId, storedResourceKey }) => {
      const session = sessionFrom(principal);
      return session.profileId === profileId && session.resources.some((entry) => entry.storedResourceKey === storedResourceKey);
    },
    verifyCsrf: async ({ principal, token }) => safeEqual(sessionFrom(principal).csrfToken, token)
  };
}

export function signDemoSession(session: SignedDemoSession, secret: string): string {
  validateSession(session);
  if (!secret) throw new Error("session secretは必須です");
  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyDemoSession(token: string, secret: string): SignedDemoSession | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || !safeEqual(createHmac("sha256", secret).update(payload).digest("base64url"), signature)) {
    return null;
  }
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    validateSession(session);
    return session.expiresAt > Math.floor(Date.now() / 1000) ? session : null;
  } catch {
    return null;
  }
}

function validateSession(value: unknown): asserts value is SignedDemoSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("demo sessionが不正です");
  const session = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion", "subjectId", "displayName", "redmineUserId", "profileId", "canCreate", "resources", "csrfToken", "expiresAt"
  ]);
  if (Object.keys(session).some((key) => !allowed.has(key)) || Object.keys(session).length !== allowed.size ||
    session.schemaVersion !== "1" || !boundedString(session.subjectId, 200) ||
    !(session.displayName === null || boundedString(session.displayName, 200)) ||
    !(session.redmineUserId === null || positiveInteger(session.redmineUserId)) ||
    !boundedString(session.profileId, 100) || typeof session.canCreate !== "boolean" ||
    !boundedString(session.csrfToken, 200) || !positiveInteger(session.expiresAt) || !Array.isArray(session.resources) ||
    session.resources.length > 100 || session.resources.some((resource) => !validResource(resource))) {
    throw new Error("demo sessionが不正です");
  }
}

function validResource(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const resource = value as Record<string, unknown>;
  return Object.keys(resource).length === 4 && resource.schemaVersion === "1" &&
    (resource.kind === "record" || resource.kind === "page") && boundedString(resource.key, 500) &&
    boundedString(resource.storedResourceKey, 200);
}

function sessionFrom(principal: object): SignedDemoSession {
  return (principal as DemoPrincipal).session;
}

function readCookie(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** 顧客固有session adapter未注入時は常に拒否し、固定principalや認証bypassを提供しない。 */
export function createRejectingSessionAdapter(): FeedbackRedmineGatewayHost {
  return {
    authenticate: async () => null,
    authorizeProfile: async () => false,
    authorizeResource: async () => null,
    authorizeStoredResource: async () => false,
    verifyCsrf: async () => false
  };
}
