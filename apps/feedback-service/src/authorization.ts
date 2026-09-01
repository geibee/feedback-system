import { createPublicKey, verify as verifySignature } from "node:crypto";
import type {
  FeedbackOperationV2,
  FeedbackResourceRefV2
} from "@geibee/feedback-contracts/v2";
import type {
  AuthorizationTarget,
  FeedbackProviderProfileV2,
  FeedbackServiceSettingsV2,
  RemoteAuthorizationDecisionV2,
  SignedGrantClaimsV2
} from "@geibee/feedback-contracts/v2/server";
import {
  FeedbackGatewayProblem,
  type FeedbackAuthorizationGrant,
  type FeedbackAuthorizationDecision,
  type FeedbackAuthorizationMode,
  type FeedbackAuthorizationPort,
  type FeedbackAuthorizationRequest,
  type FeedbackAuthorizationTarget,
  type FeedbackGatewayAccess,
  type FeedbackProfileLoaderPort
} from "@geibee/feedback-gateway";
import type { FeedbackAbortSignal } from "@geibee/feedback-connector-sdk";
import type { FeedbackSecretResolver } from "./configuration.js";

export type FeedbackHttpClientRequest = {
  url: string;
  method: "GET" | "POST";
  headers?: Readonly<Record<string, string>>;
  body?: string;
  timeoutMilliseconds: number;
  maximumResponseBytes: number;
  signal?: FeedbackAbortSignal;
};

export type FeedbackHttpClientResponse = {
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: string;
};

export interface FeedbackHttpClientPort {
  request(input: FeedbackHttpClientRequest): Promise<FeedbackHttpClientResponse>;
}

export type FeedbackAuthorizationRuntime = {
  ports: ReadonlyMap<FeedbackAuthorizationMode, FeedbackAuthorizationPort>;
  createAccess(input: {
    profileId: string;
    target: FeedbackAuthorizationTarget;
    requestedOperations: readonly FeedbackOperationV2[];
    bearerToken?: string;
    authenticatedSubjectId?: string;
    signal?: FeedbackAbortSignal;
  }): Promise<FeedbackGatewayAccess>;
};

type CachedJwks = {
  expiresAtMilliseconds: number;
  keys: ReadonlyMap<string, Record<string, unknown>>;
};

const allowedOperations = new Set<FeedbackOperationV2>([
  "feedback:read",
  "feedback:create",
  "feedback:reply",
  "feedback:revise",
  "feedback:attachment:read",
  "feedback:attachment:upload"
]);

export function createNodeFeedbackHttpClient(): FeedbackHttpClientPort {
  return Object.freeze({
    async request(input: FeedbackHttpClientRequest): Promise<FeedbackHttpClientResponse> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), input.timeoutMilliseconds);
      const unsubscribe = input.signal?.subscribe(() => controller.abort());
      try {
        const response = await fetch(input.url, {
          method: input.method,
          headers: input.headers,
          body: input.body,
          redirect: "error",
          signal: controller.signal
        });
        const declaredLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > input.maximumResponseBytes) {
          throw new Error("上流responseが上限を超えています");
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > input.maximumResponseBytes) throw new Error("上流responseが上限を超えています");
        const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return {
          status: response.status,
          headers: {
            "cache-control": response.headers.get("cache-control") ?? undefined,
            "retry-after": response.headers.get("retry-after") ?? undefined,
            "content-type": response.headers.get("content-type") ?? undefined
          },
          body
        };
      } finally {
        clearTimeout(timeout);
        unsubscribe?.();
      }
    }
  });
}

export function createFeedbackAuthorizationRuntime(input: {
  settings: FeedbackServiceSettingsV2;
  profileLoader: FeedbackProfileLoaderPort;
  secretResolver: FeedbackSecretResolver;
  httpClient: FeedbackHttpClientPort;
  nowMilliseconds?: () => number;
}): FeedbackAuthorizationRuntime {
  const nowMilliseconds = input.nowMilliseconds ?? Date.now;
  const verifier = new SignedGrantVerifier(input.settings, input.httpClient, nowMilliseconds);
  const profiles = async () => input.profileLoader.loadProfiles();

  const publicPort: FeedbackAuthorizationPort = Object.freeze({
    mode: "public-profile",
    async authorize(request: FeedbackAuthorizationRequest): Promise<FeedbackAuthorizationDecision> {
      if (request.grant.mode !== "public-profile" || request.grant.source !== "profile-reachability") {
        throw unauthorized();
      }
      return {
        target: request.target,
        mode: "public-profile",
        allowedOperations: [...request.requestedOperations]
      };
    }
  });

  const signedPort: FeedbackAuthorizationPort = Object.freeze({
    mode: "signed-grant",
    async authorize(request: FeedbackAuthorizationRequest): Promise<FeedbackAuthorizationDecision> {
      if (request.grant.mode !== "signed-grant" || request.grant.source !== "verified-jwt") {
        throw unauthorized();
      }
      const grant = request.grant;
      if (!signedGrantCoversTarget(grant.boundTarget, request.target) ||
          request.requestedOperations.some((operation) => !grant.allowedOperations.includes(operation))) throw unauthorized();
      return {
        target: request.target,
        mode: "signed-grant",
        subjectId: grant.subjectId,
        allowedOperations: [...grant.allowedOperations]
      };
    }
  });

  const remotePort: FeedbackAuthorizationPort = Object.freeze({
    mode: "remote-authorization",
    async authorize(request: FeedbackAuthorizationRequest, signal?: FeedbackAbortSignal): Promise<FeedbackAuthorizationDecision> {
      if (request.grant.mode !== "remote-authorization" || request.grant.source !== "authenticated-adapter" ||
          !sameTarget(request.target, request.grant.remoteRequest.target) ||
          request.grant.remoteRequest.subject.id !== request.grant.subjectId ||
          !sameOperationSet(request.requestedOperations, request.grant.remoteRequest.requestedOperations)) {
        throw authorizationUnavailable();
      }
      const profile = (await profiles()).find((candidate) => candidate.profileId === request.target.profileId);
      if (!profile || profile.authorization.mode !== "remote-authorization") throw authorizationUnavailable();
      const remoteAuthorization = profile.authorization;
      const remote = input.settings.remoteAuthorizationProfiles.find(
        (candidate) => candidate.id === remoteAuthorization.authorizationProfileRef
      );
      if (!remote) throw authorizationUnavailable();
      const credential = await input.secretResolver.resolve(remote.credentialRef.id).catch(() => { throw authorizationUnavailable(); });
      let response: FeedbackHttpClientResponse;
      try {
        response = await input.httpClient.request({
          url: remote.endpoint,
          method: "POST",
          headers: {
            "authorization": `Bearer ${credential}`,
            "content-type": "application/json; charset=utf-8",
            "accept": "application/json"
          },
          body: JSON.stringify(request.grant.remoteRequest),
          timeoutMilliseconds: remote.timeoutMilliseconds,
          maximumResponseBytes: 65_536,
          signal
        });
      } catch {
        throw authorizationUnavailable();
      }
      if (response.status !== 200 || !isJsonContentType(response.headers["content-type"])) throw authorizationUnavailable();
      let decision: RemoteAuthorizationDecisionV2;
      try { decision = parseRemoteDecision(response.body); }
      catch { throw authorizationUnavailable(); }
      if (!sameTarget(decision.target as FeedbackAuthorizationTarget, request.target) ||
          decision.subject.id !== request.grant.subjectId || decision.subject.source !== "authenticated-adapter" ||
          decision.allowedOperations.some((operation) => !request.requestedOperations.includes(operation))) {
        throw authorizationUnavailable();
      }
      return {
        target: request.target,
        mode: "remote-authorization",
        subjectId: request.grant.subjectId,
        allowedOperations: decision.allowedOperations,
        remoteDecision: decision
      };
    }
  });

  const ports = new Map<FeedbackAuthorizationMode, FeedbackAuthorizationPort>([
    ["public-profile", publicPort],
    ["signed-grant", signedPort],
    ["remote-authorization", remotePort]
  ]);

  return Object.freeze({
    ports,
    async createAccess(request): Promise<FeedbackGatewayAccess> {
      const profile = (await profiles()).find((candidate) => candidate.profileId === request.profileId);
      if (!profile) throw new FeedbackGatewayProblem({ code: "feedback.not_found", status: 404, message: "provider profileが見つかりません" });
      let grant: FeedbackAuthorizationGrant;
      if (profile.authorization.mode === "public-profile") {
        if (request.bearerToken) throw unauthorized();
        grant = { mode: "public-profile", source: "profile-reachability" };
      } else if (profile.authorization.mode === "signed-grant") {
        if (!request.bearerToken || request.authenticatedSubjectId) throw unauthorized();
        const verified = await verifier.verify({
          compactToken: request.bearerToken,
          profile,
          target: request.target,
          requestedOperations: request.requestedOperations
        });
        grant = {
          mode: "signed-grant",
          source: "verified-jwt",
          subjectId: verified.claims.sub,
          allowedOperations: parseScope(verified.claims.scope),
          boundTarget: verified.boundTarget
        };
      } else {
        if (request.bearerToken || !validSubject(request.authenticatedSubjectId)) throw unauthorized();
        const contractTarget = toContractTarget(request.target);
        grant = {
          mode: "remote-authorization",
          source: "authenticated-adapter",
          subjectId: request.authenticatedSubjectId,
          remoteRequest: {
            schemaVersion: "1",
            target: contractTarget,
            requestedOperations: [...request.requestedOperations] as [FeedbackOperationV2, ...FeedbackOperationV2[]],
            subject: { id: request.authenticatedSubjectId, source: "authenticated-adapter" }
          }
        };
      }
      return { grant, signal: request.signal };
    }
  });
}

class SignedGrantVerifier {
  readonly #settings: FeedbackServiceSettingsV2;
  readonly #httpClient: FeedbackHttpClientPort;
  readonly #nowMilliseconds: () => number;
  readonly #cache = new Map<string, CachedJwks>();
  readonly #refreshes = new Map<string, Promise<CachedJwks>>();

  constructor(settings: FeedbackServiceSettingsV2, httpClient: FeedbackHttpClientPort, nowMilliseconds: () => number) {
    this.#settings = settings;
    this.#httpClient = httpClient;
    this.#nowMilliseconds = nowMilliseconds;
  }

  async verify(input: {
    compactToken: string;
    profile: FeedbackProviderProfileV2;
    target: FeedbackAuthorizationTarget;
    requestedOperations: readonly FeedbackOperationV2[];
  }): Promise<{
    claims: SignedGrantClaimsV2;
    boundTarget: Extract<FeedbackAuthorizationTarget, { level: "resource" }>;
  }> {
    if (input.compactToken.length === 0 || input.compactToken.length > 16_384 ||
        input.target.level !== "resource" && input.requestedOperations.some((operation) => operation !== "feedback:read")) {
      throw unauthorized();
    }
    const segments = input.compactToken.split(".");
    if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) throw unauthorized();
    const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];
    const header = parseObject(decodeJson(encodedHeader));
    if (typeof header.alg !== "string" || typeof header.kid !== "string" || header.kid.length === 0 || header.kid.length > 200 ||
        header.jku !== undefined || header.x5u !== undefined || header.crit !== undefined) throw unauthorized();
    if (input.profile.authorization.mode !== "signed-grant") throw unauthorized();
    const signedAuthorization = input.profile.authorization;
    const issuer = this.#settings.signedGrantIssuers.find(
      (candidate) => candidate.id === signedAuthorization.issuerProfileRef
    );
    if (!issuer || header.alg !== issuer.algorithm) throw unauthorized();
    const claims = parseObject(decodeJson(encodedPayload)) as SignedGrantClaimsV2;
    const boundTarget = validateClaims(claims, {
      issuer,
      audience: `urn:geibee:feedback-service:${this.#settings.serviceId}`,
      profileId: input.profile.profileId,
      target: input.target,
      requestedOperations: input.requestedOperations,
      nowSeconds: Math.floor(this.#nowMilliseconds() / 1000)
    });
    if (!input.profile.workspacePolicy.workspaceIds.includes(boundTarget.workspaceId) ||
        !input.profile.policy.resourceKinds.includes(boundTarget.resource.kind)) throw unauthorized();
    let jwk = (await this.#keys(issuer.id, false))[header.kid];
    if (!jwk) jwk = (await this.#keys(issuer.id, true))[header.kid];
    if (!jwk || !validJwk(jwk, issuer.algorithm, header.kid)) throw unauthorized();
    const signature = decodeBase64Url(encodedSignature);
    const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii");
    let verified = false;
    try {
      const key = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
      if (issuer.algorithm === "RS256") verified = verifySignature("RSA-SHA256", signingInput, key, signature);
      if (issuer.algorithm === "ES256") verified = verifySignature("sha256", signingInput, { key, dsaEncoding: "ieee-p1363" }, signature);
      if (issuer.algorithm === "EdDSA") verified = verifySignature(null, signingInput, key, signature);
    } catch {
      verified = false;
    }
    if (!verified) throw unauthorized();
    return { claims, boundTarget };
  }

  async #keys(issuerId: string, forceRefresh: boolean): Promise<Record<string, Record<string, unknown>>> {
    const now = this.#nowMilliseconds();
    const cached = this.#cache.get(issuerId);
    if (!forceRefresh && cached && cached.expiresAtMilliseconds > now) return Object.fromEntries(cached.keys);
    if (forceRefresh) this.#cache.delete(issuerId);
    let refresh = this.#refreshes.get(issuerId);
    if (!refresh) {
      refresh = this.#fetch(issuerId);
      this.#refreshes.set(issuerId, refresh);
    }
    try {
      const next = await refresh;
      return Object.fromEntries(next.keys);
    } finally {
      if (this.#refreshes.get(issuerId) === refresh) this.#refreshes.delete(issuerId);
    }
  }

  async #fetch(issuerId: string): Promise<CachedJwks> {
    const issuer = this.#settings.signedGrantIssuers.find((candidate) => candidate.id === issuerId);
    if (!issuer) throw unauthorized();
    let response: FeedbackHttpClientResponse;
    try {
      response = await this.#httpClient.request({
        url: issuer.jwksUri,
        method: "GET",
        headers: { accept: "application/json" },
        timeoutMilliseconds: 2000,
        maximumResponseBytes: 262_144
      });
    } catch {
      throw authorizationUnavailable();
    }
    if (response.status !== 200 || !isJsonContentType(response.headers["content-type"])) throw authorizationUnavailable();
    let document: Record<string, unknown>;
    try { document = parseObject(JSON.parse(response.body)); } catch { throw authorizationUnavailable(); }
    if (Object.keys(document).some((key) => key !== "keys") || !Array.isArray(document.keys) ||
        document.keys.length > this.#settings.jwksCache.maximumKeysPerIssuer) throw authorizationUnavailable();
    const keys = new Map<string, Record<string, unknown>>();
    for (const candidate of document.keys) {
      const key = parseObject(candidate);
      if (typeof key.kid !== "string" || !key.kid || keys.has(key.kid)) throw authorizationUnavailable();
      keys.set(key.kid, key);
    }
    const upstreamTtl = cacheMaxAge(response.headers["cache-control"]);
    const ttlSeconds = Math.max(1, Math.min(this.#settings.jwksCache.maximumTtlSeconds, upstreamTtl ?? this.#settings.jwksCache.maximumTtlSeconds));
    const cached: CachedJwks = { expiresAtMilliseconds: this.#nowMilliseconds() + ttlSeconds * 1000, keys };
    if (!this.#cache.has(issuerId) && this.#cache.size >= this.#settings.jwksCache.maximumIssuers) {
      const oldest = this.#cache.keys().next().value as string | undefined;
      if (oldest) this.#cache.delete(oldest);
    }
    this.#cache.set(issuerId, cached);
    return cached;
  }
}

function validateClaims(claims: SignedGrantClaimsV2, input: {
  issuer: FeedbackServiceSettingsV2["signedGrantIssuers"][number];
  audience: string;
  profileId: string;
  target: FeedbackAuthorizationTarget;
  requestedOperations: readonly FeedbackOperationV2[];
  nowSeconds: number;
}): Extract<FeedbackAuthorizationTarget, { level: "resource" }> {
  const requiredClaims = [
    "iss", "sub", "aud", "iat", "exp", "scope", "feedback_grant_kind",
    "feedback_profile_id", "feedback_workspace_id", "feedback_resource"
  ];
  const optionalClaims = ["nbf", "jti", "azp", "client_id", "act"];
  const claimRecord = claims as unknown as Record<string, unknown>;
  const allowedClaims = new Set([...requiredClaims, ...optionalClaims]);
  if (!requiredClaims.every((key) => key in claimRecord) ||
      Object.keys(claimRecord).some((key) => !allowedClaims.has(key)) ||
      (claims.jti !== undefined && (typeof claims.jti !== "string" || claims.jti.length < 1 || claims.jti.length > 200)) ||
      claims.iss !== input.issuer.issuer || claims.aud !== input.audience ||
      !validSubject(claims.sub) || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) ||
      claims.exp <= claims.iat || claims.exp - claims.iat > 300 || claims.iat > input.nowSeconds + 30 ||
      claims.exp + 30 < input.nowSeconds ||
      (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > input.nowSeconds + 30)) ||
      claims.feedback_profile_id !== input.profileId) {
    throw unauthorized();
  }
  const resource = claims.feedback_resource as unknown;
  if (!isExactAuthorizationResource(resource) ||
      resource.kind === "workspace" && resource.key !== claims.feedback_workspace_id) throw unauthorized();
  const boundTarget = {
    level: "resource" as const,
    profileId: claims.feedback_profile_id,
    workspaceId: claims.feedback_workspace_id,
    resource
  };
  if (!signedGrantCoversTarget(boundTarget, input.target)) throw unauthorized();
  const scopes = parseScope(claims.scope);
  if (input.requestedOperations.some((operation) => !scopes.includes(operation))) throw unauthorized();
  if (claims.feedback_grant_kind !== input.issuer.grant.grantKind) throw unauthorized();
  if (input.issuer.grant.grantKind === "oidc") {
    if (claims.azp !== input.issuer.grant.clientId || claims.client_id !== undefined || claims.act !== undefined) throw unauthorized();
  } else {
    const actor = claims.act as unknown;
    if (claims.client_id !== input.issuer.grant.clientId || claims.azp !== undefined ||
        !isExactActor(actor) || actor.sub !== input.issuer.grant.actorId) throw unauthorized();
  }
  return boundTarget;
}

function signedGrantCoversTarget(
  bound: Extract<FeedbackAuthorizationTarget, { level: "resource" }>,
  requested: FeedbackAuthorizationTarget
): boolean {
  if (bound.profileId !== requested.profileId) return false;
  if (requested.level === "profile") return true;
  if (bound.workspaceId !== requested.workspaceId) return false;
  return requested.level === "workspace" || sameResource(bound.resource, requested.resource);
}

function parseRemoteDecision(source: string): RemoteAuthorizationDecisionV2 {
  let value: Record<string, unknown>;
  try { value = parseObject(JSON.parse(source)); } catch { throw authorizationUnavailable(); }
  if (!exactKeys(value, ["schemaVersion", "target", "subject", "allowedOperations"]) || value.schemaVersion !== "1") throw authorizationUnavailable();
  const target = parseAuthorizationTarget(value.target);
  const subject = parseObject(value.subject);
  if (!exactKeys(subject, ["id", "source"]) || !validSubject(subject.id) || subject.source !== "authenticated-adapter") throw authorizationUnavailable();
  if (!Array.isArray(value.allowedOperations) || value.allowedOperations.some((operation) => typeof operation !== "string" || !allowedOperations.has(operation as FeedbackOperationV2)) ||
      new Set(value.allowedOperations).size !== value.allowedOperations.length) throw authorizationUnavailable();
  return { schemaVersion: "1", target, subject: subject as unknown as RemoteAuthorizationDecisionV2["subject"], allowedOperations: value.allowedOperations as FeedbackOperationV2[] };
}

function parseAuthorizationTarget(value: unknown): RemoteAuthorizationDecisionV2["target"] {
  const target = parseObject(value);
  if (target.level === "profile" && exactKeys(target, ["level", "profileId"]) && typeof target.profileId === "string") return target as unknown as RemoteAuthorizationDecisionV2["target"];
  if (target.level === "workspace" && exactKeys(target, ["level", "profileId", "workspaceId"]) &&
      typeof target.profileId === "string" && typeof target.workspaceId === "string") return target as unknown as RemoteAuthorizationDecisionV2["target"];
  if (target.level === "resource" && exactKeys(target, ["level", "profileId", "workspaceId", "resource"]) &&
      typeof target.profileId === "string" && typeof target.workspaceId === "string" && isExactAuthorizationResource(target.resource)) return target as unknown as RemoteAuthorizationDecisionV2["target"];
  throw authorizationUnavailable();
}

function parseScope(value: unknown): FeedbackOperationV2[] {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.startsWith(" ") || value.endsWith(" ") || value.includes("  ")) throw unauthorized();
  const scopes = value.split(" ");
  if (new Set(scopes).size !== scopes.length || scopes.some((scope) => !allowedOperations.has(scope as FeedbackOperationV2))) throw unauthorized();
  return scopes as FeedbackOperationV2[];
}

function decodeJson(segment: string): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(segment))); } catch { throw unauthorized(); }
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw unauthorized();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw unauthorized();
  return bytes;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw unauthorized();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function isExactResource(value: unknown): value is FeedbackResourceRefV2 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const resource = value as Record<string, unknown>;
  return exactKeys(resource, ["kind", "key"]) && typeof resource.kind === "string" && typeof resource.key === "string" &&
    resource.kind.length > 0 && resource.kind.length <= 128 && resource.key.length > 0 && resource.key.length <= 500;
}

function isExactAuthorizationResource(value: unknown): value is { kind: "workspace" | "record" | "page"; key: string } {
  return isExactResource(value) && new Set(["workspace", "record", "page"]).has(value.kind);
}

function toContractTarget(target: FeedbackAuthorizationTarget): AuthorizationTarget {
  if (target.level === "profile") return target;
  if (target.level === "workspace") return target;
  if (!isExactAuthorizationResource(target.resource)) throw unauthorized();
  return { ...target, resource: target.resource };
}

function isExactActor(value: unknown): value is { sub: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    exactKeys(value as Record<string, unknown>, ["sub"]) && validSubject((value as { sub?: unknown }).sub);
}

function validJwk(jwk: Record<string, unknown>, algorithm: string, kid: string): boolean {
  if (jwk.kid !== kid || jwk.d !== undefined || (jwk.use !== undefined && jwk.use !== "sig") ||
      (jwk.alg !== undefined && jwk.alg !== algorithm) ||
      (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || jwk.key_ops.length !== 1 || jwk.key_ops[0] !== "verify"))) return false;
  if (algorithm === "RS256") return jwk.kty === "RSA";
  if (algorithm === "ES256") return jwk.kty === "EC" && jwk.crv === "P-256";
  return jwk.kty === "OKP" && jwk.crv === "Ed25519";
}

function sameTarget(left: FeedbackAuthorizationTarget, right: FeedbackAuthorizationTarget): boolean {
  if (left.level !== right.level || left.profileId !== right.profileId) return false;
  if (left.level === "profile" && right.level === "profile") return true;
  if (left.level === "workspace" && right.level === "workspace") return left.workspaceId === right.workspaceId;
  return left.level === "resource" && right.level === "resource" && left.workspaceId === right.workspaceId && sameResource(left.resource, right.resource);
}

function sameResource(left: FeedbackResourceRefV2, right: FeedbackResourceRefV2): boolean {
  return left.kind === right.kind && left.key === right.key;
}

function sameOperationSet(left: readonly FeedbackOperationV2[], right: readonly FeedbackOperationV2[]): boolean {
  return left.length === right.length && left.every((operation) => right.includes(operation));
}

function validSubject(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200 && value.trim().length > 0;
}

function isJsonContentType(value: string | undefined): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function cacheMaxAge(value: string | undefined): number | undefined {
  const match = value?.match(/(?:^|,)\s*max-age=(\d+)\s*(?:,|$)/iu);
  return match ? Number(match[1]) : undefined;
}

function unauthorized(): FeedbackGatewayProblem {
  return new FeedbackGatewayProblem({ code: "feedback.unauthorized", status: 401, message: "credentialを検証できません" });
}

function authorizationUnavailable(): FeedbackGatewayProblem {
  return new FeedbackGatewayProblem({
    code: "feedback.authorization_unavailable",
    status: 503,
    retryable: true,
    message: "認可serviceを検証できません"
  });
}
