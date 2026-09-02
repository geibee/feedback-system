import type { FeedbackRepositoryPort } from "@geibee/feedback-connector-sdk";
import type { FeedbackProviderProfileV2 } from "@geibee/feedback-contracts/v2/server";
import type { FeedbackEnvelopeCodecPort } from "@geibee/feedback-envelope";
import {
  createBacklogFetchTransport,
  createFeedbackBacklogConnector,
  BacklogRestV2Client,
  assertFeedbackBacklogProvisioning,
  type BacklogFetch
} from "@geibee/feedback-connector-backlog";
import {
  createFeedbackJiraCloudConnector,
  createJiraCloudFetchTransport,
  type JiraCloudFetch
} from "@geibee/feedback-connector-jira-cloud";
import {
  createFeedbackRedmineConnector,
  createFeedbackRedmineRestTransport,
  type RedmineFetch
} from "@geibee/feedback-connector-redmine";
import { nodeBacklogFetch, nodeJiraCloudFetch, nodeRedmineFetch } from "./fetch-adapters.js";

export type CatalogBase = {
  id: string;
  connectorKey: string;
  application: string;
  environment: string;
  maximumAttachmentBytes: number;
  attachmentContentTypes: readonly string[];
};

export type JiraCloudRuntimeProfile = CatalogBase & {
  connectorKey: "jira-cloud";
  siteUrl: string;
  issueTypeId: string;
  timeoutMilliseconds: number;
  pageSize: number;
  recoveryRetryAfterSeconds: number;
};

export type RedmineRuntimeProfile = CatalogBase & {
  connectorKey: "redmine";
  baseUrl: string;
  applicationKey: string;
  environmentKey: string;
  workspaceId: string;
  workspaceDisplayName: string;
  projectId: number;
  trackerId: number;
  isPrivate: boolean;
  defaultPriorityId?: number;
  customFieldIds: {
    threadId: number;
    intentId: number;
    requestHash: number;
    envelope: number;
    projection: number;
    applicationKey: number;
    environmentKey: number;
    externalWorkspaceKey: number;
    hostResourceKey: number;
  };
};

export type BacklogRuntimeProfile = CatalogBase & {
  connectorKey: "backlog";
  baseUrl: string;
  workspaceId: string;
  workspaceDisplayName: string;
  projectId: number;
  issueTypeId: number;
  priorityId: number;
  timeoutMilliseconds: number;
  pageSize: number;
  recoveryRetryAfterSeconds: number;
  maximumMetadataBytes: number;
  customFieldIds: {
    threadId: number;
    intentId: number;
    requestHash: number;
    resourceKey: number;
  };
};

export type FeedbackConnectorRuntimeProfile = JiraCloudRuntimeProfile | RedmineRuntimeProfile | BacklogRuntimeProfile;

type RepositoryContext = {
  runtimeProfile: FeedbackConnectorRuntimeProfile;
  profile: FeedbackProviderProfileV2;
  participantId: string;
  credential: string;
  envelopeCodec: FeedbackEnvelopeCodecPort;
};

export type FeedbackConnectorRuntimeAdapter = {
  connectorKey: FeedbackConnectorRuntimeProfile["connectorKey"];
  parseProfile(value: unknown): FeedbackConnectorRuntimeProfile;
  freezeProfile(profile: FeedbackConnectorRuntimeProfile): FeedbackConnectorRuntimeProfile;
  validateBinding(runtime: FeedbackConnectorRuntimeProfile, profile: FeedbackProviderProfileV2): void;
  validateCredential(secret: string): string;
  validateReadiness?(runtime: FeedbackConnectorRuntimeProfile, credential: string): Promise<void>;
  backendCapabilities(runtime: FeedbackConnectorRuntimeProfile): {
    operations: ReadonlySet<string>;
    discovery: { workspaces: "supported" | "unsupported"; resources: "supported" | "unsupported" };
    operationGuarantees: { create: "recoverable" | "best-effort" | "unsupported"; reply: "recoverable" | "best-effort" | "unsupported"; revision: "recoverable" | "best-effort" | "unsupported"; attachmentUpload: "recoverable" | "best-effort" | "unsupported" };
  };
  createRepository(context: RepositoryContext): FeedbackRepositoryPort;
};

export class FeedbackConnectorAdapterRegistry {
  readonly #adapters: ReadonlyMap<string, FeedbackConnectorRuntimeAdapter>;

  constructor(adapters: readonly FeedbackConnectorRuntimeAdapter[]) {
    const values = new Map<string, FeedbackConnectorRuntimeAdapter>();
    for (const adapter of adapters) {
      if (values.has(adapter.connectorKey)) throw new Error(`Connector adapterが重複しています: ${adapter.connectorKey}`);
      values.set(adapter.connectorKey, Object.freeze(adapter));
    }
    this.#adapters = values;
  }

  require(connectorKey: string): FeedbackConnectorRuntimeAdapter {
    const adapter = this.#adapters.get(connectorKey);
    if (!adapter) throw new Error(`Connector adapterがありません: ${connectorKey}`);
    return adapter;
  }

  keys(): readonly string[] { return [...this.#adapters.keys()]; }
}

/** profile parser、credential wire、capability、repository factoryを同じ登録点へ束ねる。 */
export function createFeedbackConnectorAdapterRegistry(input: {
  jiraFetch?: JiraCloudFetch;
  redmineFetch?: RedmineFetch;
  backlogFetch?: BacklogFetch;
} = {}): FeedbackConnectorAdapterRegistry {
  return new FeedbackConnectorAdapterRegistry([
    jiraAdapter(input.jiraFetch ?? nodeJiraCloudFetch),
    redmineAdapter(input.redmineFetch ?? nodeRedmineFetch),
    backlogAdapter(input.backlogFetch ?? nodeBacklogFetch)
  ]);
}

function jiraAdapter(fetch: JiraCloudFetch): FeedbackConnectorRuntimeAdapter {
  return {
    connectorKey: "jira-cloud",
    parseProfile: parseJiraProfile,
    freezeProfile: freezeBase,
    validateBinding() {},
    validateCredential: jiraCredential,
    backendCapabilities: () => capabilities(
      ["feedback:read", "feedback:create", "feedback:reply", "feedback:revise", "feedback:attachment:read", "feedback:attachment:upload"],
      { workspaces: "supported", resources: "supported" },
      { create: "recoverable", reply: "recoverable", revision: "best-effort", attachmentUpload: "best-effort" }
    ),
    createRepository(context) {
      const runtime = context.runtimeProfile as JiraCloudRuntimeProfile;
      return createFeedbackJiraCloudConnector({
        configuration: {
          profileId: context.profile.profileId,
          installationId: context.profile.installationId,
          application: runtime.application,
          environment: runtime.environment,
          participantId: context.participantId,
          issueTypeId: runtime.issueTypeId,
          maximumAttachmentBytes: runtime.maximumAttachmentBytes,
          attachmentContentTypes: runtime.attachmentContentTypes,
          pageSize: runtime.pageSize,
          recoveryRetryAfterSeconds: runtime.recoveryRetryAfterSeconds
        },
        transport: createJiraCloudFetchTransport({ baseUrl: runtime.siteUrl, authorization: context.credential, fetch, timeoutMilliseconds: runtime.timeoutMilliseconds }),
        envelopeCodec: context.envelopeCodec
      });
    }
  };
}

function redmineAdapter(fetch: RedmineFetch): FeedbackConnectorRuntimeAdapter {
  return {
    connectorKey: "redmine",
    parseProfile: parseRedmineProfile,
    freezeProfile(profile) {
      const value = profile as RedmineRuntimeProfile;
      return Object.freeze({ ...value, attachmentContentTypes: Object.freeze([...value.attachmentContentTypes]), customFieldIds: Object.freeze({ ...value.customFieldIds }) });
    },
    validateBinding(runtime, profile) {
      const value = runtime as RedmineRuntimeProfile;
      if (!profile.workspacePolicy.workspaceIds.includes(value.workspaceId) || profile.workspacePolicy.workspaceIds.length !== 1) throw new Error(`Redmine workspace bindingが一致しません: ${profile.profileId}`);
    },
    validateCredential: redmineCredential,
    backendCapabilities: () => capabilities(
      ["feedback:read", "feedback:create", "feedback:reply", "feedback:revise", "feedback:attachment:read", "feedback:attachment:upload"],
      { workspaces: "supported", resources: "supported" },
      { create: "recoverable", reply: "recoverable", revision: "best-effort", attachmentUpload: "best-effort" }
    ),
    createRepository(context) {
      const runtime = context.runtimeProfile as RedmineRuntimeProfile;
      return createFeedbackRedmineConnector({
        profile: {
          profileId: context.profile.profileId,
          installationId: context.profile.installationId,
          displayName: context.profile.displayName,
          applicationKey: runtime.applicationKey,
          environmentKey: runtime.environmentKey,
          workspaceId: runtime.workspaceId,
          workspaceDisplayName: runtime.workspaceDisplayName,
          projectId: runtime.projectId,
          trackerId: runtime.trackerId,
          isPrivate: runtime.isPrivate,
          ...(runtime.defaultPriorityId ? { defaultPriorityId: runtime.defaultPriorityId } : {}),
          participantId: context.participantId,
          participantDisplayName: "Feedback participant",
          customFieldIds: runtime.customFieldIds,
          maximumAttachmentBytes: runtime.maximumAttachmentBytes,
          attachmentContentTypes: runtime.attachmentContentTypes
        },
        transport: createFeedbackRedmineRestTransport({ baseUrl: runtime.baseUrl, apiKey: context.credential, fetch }),
        envelopeCodec: context.envelopeCodec
      });
    }
  };
}

function backlogAdapter(fetch: BacklogFetch): FeedbackConnectorRuntimeAdapter {
  return {
    connectorKey: "backlog",
    parseProfile: parseBacklogProfile,
    freezeProfile(profile) {
      const value = profile as BacklogRuntimeProfile;
      return Object.freeze({ ...value, attachmentContentTypes: Object.freeze([...value.attachmentContentTypes]), customFieldIds: Object.freeze({ ...value.customFieldIds }) });
    },
    validateBinding(runtime, profile) {
      const value = runtime as BacklogRuntimeProfile;
      if (!profile.workspacePolicy.workspaceIds.includes(value.workspaceId) || profile.workspacePolicy.workspaceIds.length !== 1) throw new Error(`Backlog workspace bindingが一致しません: ${profile.profileId}`);
    },
    validateCredential: backlogCredential,
    async validateReadiness(profile, credential) {
      const runtime = profile as BacklogRuntimeProfile;
      const client = new BacklogRestV2Client(createBacklogFetchTransport({
        baseUrl: runtime.baseUrl,
        apiKey: credential,
        fetch,
        timeoutMilliseconds: runtime.timeoutMilliseconds
      }));
      await assertFeedbackBacklogProvisioning(client, runtime);
    },
    backendCapabilities: () => capabilities(
      ["feedback:read", "feedback:create", "feedback:reply", "feedback:revise"],
      { workspaces: "supported", resources: "unsupported" },
      { create: "recoverable", reply: "recoverable", revision: "recoverable", attachmentUpload: "unsupported" }
    ),
    createRepository(context) {
      const runtime = context.runtimeProfile as BacklogRuntimeProfile;
      return createFeedbackBacklogConnector({
        configuration: {
          profileId: context.profile.profileId,
          installationId: context.profile.installationId,
          application: runtime.application,
          environment: runtime.environment,
          participantId: context.participantId,
          workspaceId: runtime.workspaceId,
          workspaceDisplayName: runtime.workspaceDisplayName,
          projectId: runtime.projectId,
          issueTypeId: runtime.issueTypeId,
          priorityId: runtime.priorityId,
          customFieldIds: runtime.customFieldIds,
          pageSize: runtime.pageSize,
          recoveryRetryAfterSeconds: runtime.recoveryRetryAfterSeconds,
          maximumMetadataBytes: runtime.maximumMetadataBytes
        },
        transport: createBacklogFetchTransport({ baseUrl: runtime.baseUrl, apiKey: context.credential, fetch, timeoutMilliseconds: runtime.timeoutMilliseconds }),
        envelopeCodec: context.envelopeCodec
      });
    }
  };
}

function parseJiraProfile(value: unknown): JiraCloudRuntimeProfile {
  const base = parseBase(value, "jira-cloud");
  const input = exact(value, [...baseKeys, "siteUrl", "issueTypeId", "timeoutMilliseconds", "pageSize", "recoveryRetryAfterSeconds"], "Jira Cloud Connector profile");
  httpsUrl(input.siteUrl, "Jira Cloud siteUrl");
  bounded(input.issueTypeId, "issueTypeId", 1, 100);
  integerRange(input.timeoutMilliseconds, "timeoutMilliseconds", 100, 60_000);
  integerRange(input.pageSize, "pageSize", 1, 100);
  integerRange(input.recoveryRetryAfterSeconds, "recoveryRetryAfterSeconds", 1, 300);
  return { ...base, siteUrl: input.siteUrl, issueTypeId: input.issueTypeId, timeoutMilliseconds: input.timeoutMilliseconds, pageSize: input.pageSize, recoveryRetryAfterSeconds: input.recoveryRetryAfterSeconds };
}

function parseRedmineProfile(value: unknown): RedmineRuntimeProfile {
  const base = parseBase(value, "redmine");
  const input = exact(value, [...baseKeys, "baseUrl", "applicationKey", "environmentKey", "workspaceId", "workspaceDisplayName", "projectId", "trackerId", "isPrivate", "defaultPriorityId", "customFieldIds"], "Redmine Connector profile", ["defaultPriorityId"]);
  httpsUrl(input.baseUrl, "Redmine baseUrl");
  key(input.applicationKey, "applicationKey"); key(input.environmentKey, "environmentKey"); key(input.workspaceId, "workspaceId");
  bounded(input.workspaceDisplayName, "workspaceDisplayName", 1, 200);
  positiveInteger(input.projectId, "projectId"); positiveInteger(input.trackerId, "trackerId");
  if (typeof input.isPrivate !== "boolean") throw new Error("isPrivateが不正です");
  if (input.defaultPriorityId !== undefined) positiveInteger(input.defaultPriorityId, "defaultPriorityId");
  const names = ["threadId", "intentId", "requestHash", "envelope", "projection", "applicationKey", "environmentKey", "externalWorkspaceKey", "hostResourceKey"];
  const fields = exact(input.customFieldIds, names, "customFieldIds");
  Object.entries(fields).forEach(([name, id]) => positiveInteger(id, `customFieldIds.${name}`));
  if (new Set(Object.values(fields)).size !== names.length) throw new Error("customFieldIdsが重複しています");
  return { ...base, baseUrl: input.baseUrl, applicationKey: input.applicationKey, environmentKey: input.environmentKey, workspaceId: input.workspaceId, workspaceDisplayName: input.workspaceDisplayName, projectId: input.projectId, trackerId: input.trackerId, isPrivate: input.isPrivate, ...(input.defaultPriorityId === undefined ? {} : { defaultPriorityId: input.defaultPriorityId }), customFieldIds: fields as RedmineRuntimeProfile["customFieldIds"] };
}

function parseBacklogProfile(value: unknown): BacklogRuntimeProfile {
  const base = parseBase(value, "backlog");
  const input = exact(value, [...baseKeys, "baseUrl", "workspaceId", "workspaceDisplayName", "projectId", "issueTypeId", "priorityId", "timeoutMilliseconds", "pageSize", "recoveryRetryAfterSeconds", "maximumMetadataBytes", "customFieldIds"], "Backlog Connector profile");
  httpsOrigin(input.baseUrl, "Backlog baseUrl");
  key(input.workspaceId, "workspaceId"); bounded(input.workspaceDisplayName, "workspaceDisplayName", 1, 200);
  for (const name of ["projectId", "issueTypeId", "priorityId", "maximumMetadataBytes"] as const) positiveInteger(input[name], name);
  integerRange(input.timeoutMilliseconds, "timeoutMilliseconds", 100, 60_000);
  integerRange(input.pageSize, "pageSize", 1, 100);
  integerRange(input.recoveryRetryAfterSeconds, "recoveryRetryAfterSeconds", 1, 300);
  const names = ["threadId", "intentId", "requestHash", "resourceKey"];
  const fields = exact(input.customFieldIds, names, "Backlog customFieldIds");
  Object.entries(fields).forEach(([name, id]) => positiveInteger(id, `customFieldIds.${name}`));
  if (new Set(Object.values(fields)).size !== names.length) throw new Error("Backlog customFieldIdsが重複しています");
  if (base.attachmentContentTypes.length !== 0 || base.maximumAttachmentBytes !== 1) throw new Error("Backlog attachment無効設定が不正です");
  return { ...base, baseUrl: input.baseUrl, workspaceId: input.workspaceId, workspaceDisplayName: input.workspaceDisplayName, projectId: input.projectId, issueTypeId: input.issueTypeId, priorityId: input.priorityId, timeoutMilliseconds: input.timeoutMilliseconds, pageSize: input.pageSize, recoveryRetryAfterSeconds: input.recoveryRetryAfterSeconds, maximumMetadataBytes: input.maximumMetadataBytes, customFieldIds: fields as BacklogRuntimeProfile["customFieldIds"] };
}

const baseKeys = ["id", "connectorKey", "application", "environment", "maximumAttachmentBytes", "attachmentContentTypes"];
const stableKey = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
function parseBase<TKey extends FeedbackConnectorRuntimeProfile["connectorKey"]>(value: unknown, connectorKey: TKey): CatalogBase & { connectorKey: TKey } {
  const input = record(value, "Connector profile");
  if (input.connectorKey !== connectorKey) throw new Error("Connector keyが一致しません");
  key(input.id, "Connector profile ID"); key(input.application, "application"); key(input.environment, "environment");
  positiveInteger(input.maximumAttachmentBytes, "maximumAttachmentBytes");
  const attachmentContentTypes = strings(input.attachmentContentTypes, "attachmentContentTypes", 0, 100);
  for (const contentType of attachmentContentTypes) if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(contentType)) throw new Error("attachment content typeが不正です");
  return { id: input.id, connectorKey, application: input.application, environment: input.environment, maximumAttachmentBytes: input.maximumAttachmentBytes, attachmentContentTypes };
}

function freezeBase(profile: FeedbackConnectorRuntimeProfile): FeedbackConnectorRuntimeProfile { return Object.freeze({ ...profile, attachmentContentTypes: Object.freeze([...profile.attachmentContentTypes]) }); }
function capabilities(operations: readonly string[], discovery: { workspaces: "supported" | "unsupported"; resources: "supported" | "unsupported" }, operationGuarantees: ReturnType<FeedbackConnectorRuntimeAdapter["backendCapabilities"]>["operationGuarantees"]) { return { operations: new Set(operations), discovery, operationGuarantees }; }

function jiraCredential(secret: string): string {
  const value = exact(parseJson(secret, "Jira Cloud credential"), ["kind", "email", "apiToken"], "Jira Cloud credential");
  if (value.kind !== "jira-cloud-basic") throw new Error("Jira Cloud credential kindが不正です");
  bounded(value.email, "Jira Cloud email", 3, 320); bounded(value.apiToken, "Jira Cloud API token", 1, 4096);
  return `Basic ${Buffer.from(`${value.email}:${value.apiToken}`, "utf8").toString("base64")}`;
}
function redmineCredential(secret: string): string {
  const value = exact(parseJson(secret, "Redmine credential"), ["kind", "apiKey"], "Redmine credential");
  if (value.kind !== "redmine-api-key") throw new Error("Redmine credential kindが不正です"); bounded(value.apiKey, "Redmine API key", 1, 4096); return value.apiKey;
}
function backlogCredential(secret: string): string {
  const value = exact(parseJson(secret, "Backlog credential"), ["kind", "apiKey"], "Backlog credential");
  if (value.kind !== "backlog-api-key") throw new Error("Backlog credential kindが不正です"); bounded(value.apiKey, "Backlog API key", 1, 4096); return value.apiKey;
}
function parseJson(source: string, name: string): unknown { try { return JSON.parse(source); } catch { throw new Error(`${name} secretが不正です`); } }
function record(value: unknown, name: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name}がobjectではありません`); return value as Record<string, unknown>; }
function exact(value: unknown, keys: readonly string[], name: string, optional: readonly string[] = []): Record<string, any> { const result = record(value, name); const allowed = new Set(keys); if (Object.keys(result).some((candidate) => !allowed.has(candidate))) throw new Error(`${name}にunknown fieldがあります`); if (keys.some((candidate) => !optional.includes(candidate) && !(candidate in result))) throw new Error(`${name}の必須fieldがありません`); return result; }
function key(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !stableKey.test(value)) throw new Error(`${name}が不正です`); }
function bounded(value: unknown, name: string, minimum: number, maximum: number): asserts value is string { if (typeof value !== "string" || value.length < minimum || value.length > maximum) throw new Error(`${name}が不正です`); }
function strings(value: unknown, name: string, minimum: number, maximum: number): string[] { if (!Array.isArray(value) || value.length < minimum || value.length > maximum || value.some((entry) => typeof entry !== "string") || new Set(value).size !== value.length) throw new Error(`${name}が不正または重複しています`); return value as string[]; }
function positiveInteger(value: unknown, name: string): asserts value is number { integerRange(value, name, 1, Number.MAX_SAFE_INTEGER); }
function integerRange(value: unknown, name: string, minimum: number, maximum: number): asserts value is number { if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${name}が不正です`); }
function httpsUrl(value: unknown, name: string): asserts value is string { bounded(value, name, 1, 500); let url: URL; try { url = new URL(value); } catch { throw new Error(`${name}が不正です`); } if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error(`${name}はcredentialなしのHTTPS URLで指定してください`); }
function httpsOrigin(value: unknown, name: string): asserts value is string { httpsUrl(value, name); if (new URL(value).origin !== value) throw new Error(`${name}はHTTPS originで指定してください`); }
