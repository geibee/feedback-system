import type { FeedbackRepositoryPort } from "@geibee/feedback-connector-sdk";
import type { FeedbackProviderProfileV2 } from "@geibee/feedback-contracts/v2/server";
import {
  FeedbackGatewayApplicationService,
  type FeedbackAuthorizationDecision,
  type FeedbackGatewayAccess,
  type FeedbackProjectionVerifierPort
} from "@geibee/feedback-gateway";
import {
  createFeedbackAuthorizationRuntime,
  createNodeFeedbackHttpClient,
  type FeedbackHttpClientPort
} from "./authorization.js";
import type { FeedbackReadOnlyConfiguration } from "./configuration.js";
import { createFeedbackHttpHandler, type FeedbackHttpRequestContext } from "./http.js";
import type { FeedbackParticipantPrincipal } from "./participant.js";
import { createFeedbackV1FacadeGuard } from "./v1-facade.js";

type FeedbackRepositoryResolution = {
  profile: FeedbackProviderProfileV2;
  authorization: FeedbackAuthorizationDecision;
  access: FeedbackGatewayAccess;
};

export type FeedbackService = {
  handle(request: Request, context?: FeedbackHttpRequestContext): Promise<Response>;
  authorizeV1: ReturnType<typeof createFeedbackV1FacadeGuard>;
  readiness(): Promise<
    | { ready: true; profileCount: number }
    | { ready: false; profileCount: number }
  >;
};

export interface FeedbackProviderCredentialValidatorPort {
  validate(input: { profile: FeedbackProviderProfileV2; secret: string }): Promise<void> | void;
}

export function createFeedbackService(input: {
  configuration: FeedbackReadOnlyConfiguration;
  connectors: ReadonlyMap<string, FeedbackRepositoryPort>;
  projectionVerifier: FeedbackProjectionVerifierPort;
  expectedOrigin: string;
  basePath?: string;
  maximumRequestBytes: number;
  operationTimeoutMilliseconds: number;
  httpClient?: FeedbackHttpClientPort;
  providerCredentialValidator?: FeedbackProviderCredentialValidatorPort;
  repositoryResolver?: (
    resolution: FeedbackRepositoryResolution & { participantPrincipal: FeedbackParticipantPrincipal | null }
  ) => Promise<FeedbackRepositoryPort> | FeedbackRepositoryPort;
}): FeedbackService {
  const authorization = createFeedbackAuthorizationRuntime({
    settings: input.configuration.settings,
    profileLoader: input.configuration.profileLoader,
    secretResolver: input.configuration.secretResolver,
    httpClient: input.httpClient ?? createNodeFeedbackHttpClient()
  });
  const participantByAccess = new WeakMap<object, FeedbackParticipantPrincipal | null>();
  const gateway = new FeedbackGatewayApplicationService({
    profileLoader: input.configuration.profileLoader,
    authorizationPorts: authorization.ports,
    connectors: input.connectors,
    ...(input.repositoryResolver ? {
      repositoryResolver: (resolution: FeedbackRepositoryResolution) => input.repositoryResolver!({
        ...resolution,
        participantPrincipal: participantByAccess.get(resolution.access) ?? null
      })
    } : {}),
    projectionVerifier: input.projectionVerifier
  });
  const handle = createFeedbackHttpHandler({
    gateway,
    authorization,
    profileLoader: input.configuration.profileLoader,
    secretResolver: input.configuration.secretResolver,
    expectedOrigin: input.expectedOrigin,
    basePath: input.basePath ?? "/internal/feedback/v2",
    maximumRequestBytes: input.maximumRequestBytes,
    operationTimeoutMilliseconds: input.operationTimeoutMilliseconds,
    bindParticipant({ access, principal }) {
      participantByAccess.set(access, principal);
    }
  });
  const authorizeV1 = createFeedbackV1FacadeGuard({ gateway, authorization });

  return Object.freeze({
    handle,
    authorizeV1,
    async readiness() {
      let profileCount = 0;
      try {
        const profiles = await input.configuration.profileLoader.loadProfiles();
        profileCount = profiles.length;
        for (const profile of profiles) {
          if (!input.repositoryResolver && !input.connectors.has(profile.connectorKey)) {
            throw new Error(`Connectorがありません: ${profile.connectorKey}`);
          }
          const providerCredential = await input.configuration.secretResolver.resolve(
            profile.secretRefs.providerCredential.id
          );
          await validateProviderCredential({
            profile,
            secret: providerCredential,
            customValidator: input.providerCredentialValidator
          });
          validateSigningKeyRing(
            await input.configuration.secretResolver.resolve(profile.secretRefs.envelopeKeyRing.id),
            "Envelope key ring"
          );
          validateSigningKeyRing(
            await input.configuration.secretResolver.resolve(profile.secretRefs.participantCredentialKeyRing.id),
            "participant credential key ring"
          );
          validateSecretKey(
            await input.configuration.secretResolver.resolve(profile.secretRefs.participantIdDerivationKey.id),
            "participant ID derivation key"
          );
          if (profile.secretRefs.authorizationCredential) {
            await input.configuration.secretResolver.resolve(profile.secretRefs.authorizationCredential.id);
          }
        }
        for (const remote of input.configuration.settings.remoteAuthorizationProfiles) {
          await input.configuration.secretResolver.resolve(remote.credentialRef.id);
        }
        return { ready: true, profileCount };
      } catch {
        return { ready: false, profileCount };
      }
    }
  });
}

async function validateProviderCredential(input: {
  profile: FeedbackProviderProfileV2;
  secret: string;
  customValidator?: FeedbackProviderCredentialValidatorPort;
}): Promise<void> {
  if (input.customValidator) {
    await input.customValidator.validate({ profile: input.profile, secret: input.secret });
    return;
  }
  if (input.profile.connectorKey === "jira-cloud") {
    const credential = exactObject(parseJson(input.secret, "Jira Cloud credential"), [
      "kind", "email", "apiToken"
    ], "Jira Cloud credential");
    if (credential.kind !== "jira-cloud-basic") throw new Error("Jira Cloud credential kindが不正です");
    assertBoundedString(credential.email, "Jira Cloud email", 3, 320);
    assertBoundedString(credential.apiToken, "Jira Cloud API token", 1, 4096);
    return;
  }
  if (input.profile.connectorKey === "redmine") {
    const credential = exactObject(parseJson(input.secret, "Redmine credential"), [
      "kind", "apiKey"
    ], "Redmine credential");
    if (credential.kind !== "redmine-api-key") throw new Error("Redmine credential kindが不正です");
    assertBoundedString(credential.apiKey, "Redmine API key", 1, 4096);
    return;
  }
  throw new Error(`provider credential validatorがありません: ${input.profile.connectorKey}`);
}

function validateSigningKeyRing(source: string, name: string): void {
  const ring = exactObject(parseJson(source, name), ["activeKid", "keys"], name);
  if (typeof ring.activeKid !== "string" || !Array.isArray(ring.keys) ||
      ring.keys.length === 0 || ring.keys.length > 8) {
    throw new Error(`${name}が不正です`);
  }
  const kids = new Set<string>();
  let activeKeyCount = 0;
  for (const entry of ring.keys) {
    const key = exactObject(entry, ["kid", "key"], `${name} key`);
    if (typeof key.kid !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(key.kid) ||
        kids.has(key.kid)) {
      throw new Error(`${name} kidが不正または重複しています`);
    }
    kids.add(key.kid);
    validateSecretKey(key.key, `${name} key`);
    if (key.kid === ring.activeKid) activeKeyCount += 1;
    // activeKid以外の鍵はverify-onlyであり、新規署名には利用しない。
  }
  if (activeKeyCount !== 1) throw new Error(`${name}のactive keyは1個必要です`);
}

function validateSecretKey(value: unknown, name: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error(`${name}がbase64urlではありません`);
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value || bytes.byteLength < 32) {
    throw new Error(`${name}は32 bytes以上が必要です`);
  }
}

function parseJson(source: string, name: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error(`${name} secretが不正です`);
  }
}

function exactObject(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name}がobjectではありません`);
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== keys.length || keys.some((key) => !(key in object))) {
    throw new Error(`${name}のfieldが不正です`);
  }
  return object;
}

function assertBoundedString(value: unknown, name: string, minimum: number, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new Error(`${name}が不正です`);
  }
}
