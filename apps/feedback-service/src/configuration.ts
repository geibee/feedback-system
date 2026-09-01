import { readFile as nodeReadFile } from "node:fs/promises";
import type {
  FeedbackProviderProfileV2,
  FeedbackServiceSettingsV2
} from "@geibee/feedback-contracts/v2/server";
import type { FeedbackProfileLoaderPort } from "@geibee/feedback-gateway";

export interface FeedbackSecretResolver {
  resolve(secretId: string): Promise<string>;
}

export type FeedbackReadTextFile = (absolutePath: string) => Promise<string>;

export type FeedbackReadOnlyConfiguration = {
  settings: FeedbackServiceSettingsV2;
  profileLoader: FeedbackProfileLoaderPort;
  secretResolver: FeedbackSecretResolver;
};

const authorizationModes = new Set(["public-profile", "signed-grant", "remote-authorization"]);
const operations = new Set([
  "feedback:read",
  "feedback:create",
  "feedback:reply",
  "feedback:revise",
  "feedback:attachment:read",
  "feedback:attachment:upload"
]);
const stableKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const secretIdPattern = /^[A-Z][A-Z0-9_]{0,127}$/u;

export async function loadFeedbackReadOnlyConfiguration(input: {
  settingsFile: string;
  environment: Readonly<Record<string, string | undefined>>;
  readTextFile?: FeedbackReadTextFile;
}): Promise<FeedbackReadOnlyConfiguration> {
  if (!input.settingsFile.startsWith("/") || input.settingsFile.includes("\0")) {
    throw new Error("Feedback Service settings fileはabsolute pathで指定してください");
  }
  const readTextFile = input.readTextFile ?? (async (path) => nodeReadFile(path, "utf8"));
  const settings = validateSettings(parseJson(await readTextFile(input.settingsFile), "settings"));
  const profiles: FeedbackProviderProfileV2[] = [];
  const profileIds = new Set<string>();
  for (const profileFile of settings.profileFiles) {
    const profile = validateProfile(parseJson(await readTextFile(profileFile), "provider profile"));
    if (profileIds.has(profile.profileId)) throw new Error(`provider profile IDが重複しています: ${profile.profileId}`);
    profileIds.add(profile.profileId);
    validateProfileReferences(profile, settings);
    profiles.push(deepFreeze(profile));
  }
  const snapshot = Object.freeze(profiles);
  return Object.freeze({
    settings: deepFreeze(settings),
    profileLoader: Object.freeze({ loadProfiles: async () => snapshot }),
    secretResolver: createEnvironmentSecretResolver(input.environment)
  });
}

export async function loadFeedbackConfigurationFromEnvironment(input: {
  environment: Readonly<Record<string, string | undefined>>;
  readTextFile?: FeedbackReadTextFile;
}): Promise<FeedbackReadOnlyConfiguration> {
  const settingsFile = input.environment.FEEDBACK_SERVICE_SETTINGS_FILE;
  if (!settingsFile) throw new Error("FEEDBACK_SERVICE_SETTINGS_FILEがありません");
  return loadFeedbackReadOnlyConfiguration({ ...input, settingsFile });
}

export function createEnvironmentSecretResolver(
  environment: Readonly<Record<string, string | undefined>>
): FeedbackSecretResolver {
  return Object.freeze({
    async resolve(secretId: string): Promise<string> {
      if (!secretIdPattern.test(secretId)) throw new Error("secret reference IDが不正です");
      const value = environment[secretId];
      if (value === undefined || value.length === 0) throw new Error(`必須secretを解決できません: ${secretId}`);
      return value;
    }
  });
}

function validateSettings(value: unknown): FeedbackServiceSettingsV2 {
  const object = exactObject(value, [
    "schemaVersion", "serviceId", "profileFiles", "signedGrantIssuers", "remoteAuthorizationProfiles", "jwksCache"
  ], "settings");
  if (object.schemaVersion !== "2" || typeof object.serviceId !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,99}$/u.test(object.serviceId)) {
    throw new Error("Feedback Service settingsのversionまたはserviceIdが不正です");
  }
  const profileFiles = stringArray(object.profileFiles, "profileFiles", 1, 100);
  if (new Set(profileFiles).size !== profileFiles.length || profileFiles.some((path) => !path.startsWith("/") || path.includes("\0"))) {
    throw new Error("profileFilesは重複のないabsolute pathで指定してください");
  }
  const issuers = array(object.signedGrantIssuers, "signedGrantIssuers", 0, 32).map((entry) => {
    const issuer = exactObject(entry, ["id", "issuer", "jwksUri", "algorithm", "grant"], "signed grant issuer");
    assertStableKey(issuer.id, "signed grant issuer ID");
    assertHttpsUrl(issuer.issuer, "issuer");
    assertHttpsUrl(issuer.jwksUri, "jwksUri");
    if (!new Set(["RS256", "ES256", "EdDSA"]).has(String(issuer.algorithm))) throw new Error("signed grant algorithmが不正です");
    const grant = exactObject(issuer.grant, ["grantKind", "clientId", "actorId"], "issuer grant", true);
    if (grant.grantKind === "oidc") {
      exactKeys(grant, ["grantKind", "clientId"], "OIDC issuer grant");
      assertBoundedString(grant.clientId, "clientId", 1, 200);
      return { id: issuer.id as string, grant: { grantKind: "oidc" as const, clientId: grant.clientId as string } };
    }
    if (grant.grantKind === "token-exchange") {
      exactKeys(grant, ["grantKind", "clientId", "actorId"], "token exchange issuer grant");
      assertBoundedString(grant.clientId, "clientId", 1, 200);
      assertBoundedString(grant.actorId, "actorId", 1, 200);
      return {
        id: issuer.id as string,
        grant: { grantKind: "token-exchange" as const, clientId: grant.clientId as string, actorId: grant.actorId as string }
      };
    }
    throw new Error("signed grant kindが不正です");
  });
  uniqueIds(issuers, "signed grant issuer");
  const remoteProfiles = array(object.remoteAuthorizationProfiles, "remoteAuthorizationProfiles", 0, 100).map((entry) => {
    const remote = exactObject(entry, ["id", "endpoint", "timeoutMilliseconds", "credentialRef"], "remote authorization profile");
    assertStableKey(remote.id, "remote authorization profile ID");
    assertHttpsUrl(remote.endpoint, "remote authorization endpoint");
    if (remote.timeoutMilliseconds !== 2000) throw new Error("remote authorization timeoutは2000msに固定してください");
    return { id: remote.id as string, credentialRef: validateSecretReference(remote.credentialRef) };
  });
  uniqueIds(remoteProfiles, "remote authorization profile");
  const cache = exactObject(object.jwksCache, ["maximumIssuers", "maximumKeysPerIssuer", "maximumTtlSeconds"], "jwksCache");
  assertIntegerRange(cache.maximumIssuers, "maximumIssuers", 1, 32);
  assertIntegerRange(cache.maximumKeysPerIssuer, "maximumKeysPerIssuer", 1, 32);
  assertIntegerRange(cache.maximumTtlSeconds, "maximumTtlSeconds", 1, 300);
  return object as unknown as FeedbackServiceSettingsV2;
}

function validateProfile(value: unknown): FeedbackProviderProfileV2 {
  const object = exactObject(value, [
    "schemaVersion", "profileId", "displayName", "connectorKey", "installationId", "connectorProfileRef",
    "workspacePolicy", "authorization", "policy", "capabilities", "secretRefs"
  ], "provider profile", true);
  if (object.schemaVersion !== "2") throw new Error("provider profile schemaVersionが不正です");
  assertStableKey(object.profileId, "profileId");
  assertBoundedString(object.displayName, "displayName", 1, 200);
  assertStableKey(object.connectorKey, "connectorKey");
  assertBoundedString(object.installationId, "installationId", 1, 500);
  if (object.connectorProfileRef !== undefined) assertStableKey(object.connectorProfileRef, "connectorProfileRef");
  const workspacePolicy = exactObject(object.workspacePolicy, ["workspaceIds", "workspaceDiscovery", "resourceDiscovery"], "workspacePolicy");
  const workspaceIds = stringArray(workspacePolicy.workspaceIds, "workspaceIds", 1, 100);
  workspaceIds.forEach((id) => assertStableKey(id, "workspaceId"));
  if (new Set(workspaceIds).size !== workspaceIds.length) throw new Error("workspaceIdsが重複しています");
  assertSupport(workspacePolicy.workspaceDiscovery, "workspaceDiscovery");
  assertSupport(workspacePolicy.resourceDiscovery, "resourceDiscovery");

  const authorization = exactObject(object.authorization,
    ["mode", "issuerProfileRef", "authorizationProfileRef", "subjectSource"], "authorization", true);
  if (!authorizationModes.has(String(authorization.mode))) throw new Error("Authorization Modeが不正です");
  if (authorization.mode === "public-profile") exactKeys(authorization, ["mode"], "public-profile authorization");
  if (authorization.mode === "signed-grant") {
    exactKeys(authorization, ["mode", "issuerProfileRef"], "signed-grant authorization");
    assertStableKey(authorization.issuerProfileRef, "issuerProfileRef");
  }
  if (authorization.mode === "remote-authorization") {
    exactKeys(authorization, ["mode", "authorizationProfileRef", "subjectSource"], "remote authorization");
    assertStableKey(authorization.authorizationProfileRef, "authorizationProfileRef");
    if (authorization.subjectSource !== "authenticated-adapter") throw new Error("remote subjectSourceが不正です");
  }

  const policy = exactObject(object.policy, ["operations", "resourceKinds"], "profile policy");
  const policyOperations = stringArray(policy.operations, "policy operations", 0, 6);
  policyOperations.forEach(assertOperation);
  assertUnique(policyOperations, "policy operations");
  const resourceKinds = stringArray(policy.resourceKinds, "resourceKinds", 1, 100);
  resourceKinds.forEach((kind) => assertStableKey(kind, "resource kind"));
  assertUnique(resourceKinds, "resourceKinds");
  const capabilities = exactObject(object.capabilities, [
    "operations", "discovery", "operationGuarantees", "creationFields", "maximumMetadataBytes",
    "projectionValidation", "uniqueThreadLookup"
  ], "backend capabilities");
  const capabilityOperations = stringArray(capabilities.operations, "capability operations", 0, 6);
  capabilityOperations.forEach(assertOperation);
  assertUnique(capabilityOperations, "capability operations");
  const discovery = exactObject(capabilities.discovery, ["workspaces", "resources"], "capability discovery");
  assertSupport(discovery.workspaces, "capability workspaces");
  assertSupport(discovery.resources, "capability resources");
  const guarantees = exactObject(capabilities.operationGuarantees,
    ["create", "reply", "revision", "attachmentUpload"], "operation guarantees");
  for (const guarantee of Object.values(guarantees)) {
    if (!new Set(["recoverable", "best-effort", "unsupported"]).has(String(guarantee))) throw new Error("operation guaranteeが不正です");
  }
  for (const value of array(capabilities.creationFields, "creationFields", 0, 50)) {
    const field = exactObject(value, ["key", "label", "type", "required", "options"], "creation field", true);
    for (const required of ["key", "label", "type", "required"]) {
      if (!(required in field)) throw new Error("creation fieldの必須fieldがありません");
    }
    assertStableKey(field.key, "creation field key");
    assertBoundedString(field.label, "creation field label", 1, 200);
    if (!new Set(["text", "date", "select", "reference"]).has(String(field.type)) || typeof field.required !== "boolean") {
      throw new Error("creation field typeまたはrequiredが不正です");
    }
    if (field.options !== undefined) {
      for (const optionValue of array(field.options, "creation field options", 0, 500)) {
        const option = exactObject(optionValue, ["value", "label"], "creation field option");
        assertBoundedString(option.value, "creation field option value", 1, 500);
        assertBoundedString(option.label, "creation field option label", 1, 200);
      }
    }
  }
  assertIntegerRange(capabilities.maximumMetadataBytes, "maximumMetadataBytes", 1024, Number.MAX_SAFE_INTEGER);
  if (capabilities.projectionValidation !== "envelope-required" || capabilities.uniqueThreadLookup !== true) {
    throw new Error("projection validationまたはunique thread lookupが不正です");
  }
  const secretRefs = exactObject(object.secretRefs, [
    "providerCredential", "envelopeKeyRing", "participantCredentialKeyRing",
    "participantIdDerivationKey", "authorizationCredential"
  ], "secretRefs", true);
  for (const required of ["providerCredential", "envelopeKeyRing", "participantCredentialKeyRing", "participantIdDerivationKey"] as const) {
    validateSecretReference(secretRefs[required]);
  }
  if (secretRefs.authorizationCredential !== undefined) validateSecretReference(secretRefs.authorizationCredential);
  const separatedKeyIds = ["envelopeKeyRing", "participantCredentialKeyRing", "participantIdDerivationKey"]
    .map((name) => (secretRefs[name] as { id: string }).id);
  if (new Set(separatedKeyIds).size !== separatedKeyIds.length) {
    throw new Error("Envelope、participant credential、participant ID導出鍵は別secretにしてください");
  }
  return object as unknown as FeedbackProviderProfileV2;
}

function validateProfileReferences(profile: FeedbackProviderProfileV2, settings: FeedbackServiceSettingsV2): void {
  if (profile.authorization.mode === "signed-grant") {
    const issuerProfileRef = profile.authorization.issuerProfileRef;
    if (!settings.signedGrantIssuers.some((issuer) => issuer.id === issuerProfileRef)) {
      throw new Error(`signed grant issuer profileがありません: ${issuerProfileRef}`);
    }
  }
  if (profile.authorization.mode === "remote-authorization") {
    const authorizationProfileRef = profile.authorization.authorizationProfileRef;
    if (!settings.remoteAuthorizationProfiles.some((remote) => remote.id === authorizationProfileRef)) {
      throw new Error(`remote authorization profileがありません: ${authorizationProfileRef}`);
    }
  }
}

function validateSecretReference(value: unknown): { kind: "server-secret"; id: string } {
  const reference = exactObject(value, ["kind", "id"], "secret reference");
  if (reference.kind !== "server-secret" || typeof reference.id !== "string" || !secretIdPattern.test(reference.id)) {
    throw new Error("secret referenceが不正です");
  }
  return reference as { kind: "server-secret"; id: string };
}

function parseJson(source: string, name: string): unknown {
  if (source.length > 1_048_576) throw new Error(`${name}が上限を超えています`);
  try { return JSON.parse(source); } catch { throw new Error(`${name} JSONが不正です`); }
}

function exactObject(value: unknown, keys: readonly string[], name: string, allowOptional = false): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name}がobjectではありません`);
  const object = value as Record<string, unknown>;
  if (!allowOptional && keys.some((key) => !(key in object))) throw new Error(`${name}の必須fieldがありません`);
  exactKeys(object, keys, name);
  return object;
}

function exactKeys(object: Record<string, unknown>, keys: readonly string[], name: string): void {
  const allowed = new Set(keys);
  if (Object.keys(object).some((key) => !allowed.has(key))) throw new Error(`${name}にunknown fieldがあります`);
}

function array(value: unknown, name: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`${name}がarray上限に違反しています`);
  return value;
}

function stringArray(value: unknown, name: string, minimum: number, maximum: number): string[] {
  const values = array(value, name, minimum, maximum);
  if (values.some((entry) => typeof entry !== "string")) throw new Error(`${name}にstring以外があります`);
  return values as string[];
}

function assertStableKey(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !stableKeyPattern.test(value)) throw new Error(`${name}が不正です`);
}

function assertBoundedString(value: unknown, name: string, minimum: number, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) throw new Error(`${name}が不正です`);
}

function assertHttpsUrl(value: unknown, name: string): void {
  assertBoundedString(value, name, 1, 500);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name}がURLではありません`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(`${name}はcredentialを含まないHTTPS URLが必要です`);
}

function assertOperation(value: string): void {
  if (!operations.has(value)) throw new Error(`未対応operationです: ${value}`);
}

function assertSupport(value: unknown, name: string): void {
  if (value !== "supported" && value !== "unsupported") throw new Error(`${name}が不正です`);
}

function assertIntegerRange(value: unknown, name: string, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${name}が範囲外です`);
}

function uniqueIds(values: readonly { id?: unknown }[], name: string): void {
  const ids = values.map((value) => value.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${name} IDが重複しています`);
}

function assertUnique(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${name}が重複しています`);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
