import type { FeedbackRepositoryPort } from "@geibee/feedback-connector-sdk";
import type { FeedbackProviderProfileV2 } from "@geibee/feedback-contracts/v2/server";
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
import { FeedbackGatewayProblem } from "@geibee/feedback-gateway";
import {
  createFeedbackService,
  loadFeedbackConfigurationFromEnvironment,
  type FeedbackHttpClientPort,
  type FeedbackService
} from "@geibee/feedback-service";
import {
  loadFeedbackConnectorCatalog,
  validateConnectorCatalogBindings,
  type FeedbackConnectorCatalog,
  type FeedbackConnectorRuntimeProfile
} from "./catalog.js";
import { nodeJiraCloudFetch, nodeRedmineFetch } from "./fetch-adapters.js";
import { createProductionFeedbackProjectionVerifier } from "./projection.js";
import {
  loadFeedbackEnvelopeCodec,
  participantIdForAuthorization,
  resolveProviderAuthorization
} from "./secrets.js";

export type FeedbackProductionRuntime = {
  service: FeedbackService;
  catalog: FeedbackConnectorCatalog;
  profiles: readonly FeedbackProviderProfileV2[];
  expectedOrigin: string;
  basePath: string;
  hasRemoteAuthorizationProfiles: boolean;
};

export async function createFeedbackProductionRuntime(input: {
  environment: Readonly<Record<string, string | undefined>>;
  jiraFetch?: JiraCloudFetch;
  redmineFetch?: RedmineFetch;
  authorizationHttpClient?: FeedbackHttpClientPort;
}): Promise<FeedbackProductionRuntime> {
  const environment = input.environment;
  const connectorProfilesFile = required(environment, "FEEDBACK_CONNECTOR_PROFILES_FILE");
  const expectedOrigin = origin(required(environment, "FEEDBACK_PUBLIC_ORIGIN"));
  const basePath = basePathValue(environment.FEEDBACK_SERVICE_BASE_PATH ?? "/internal/feedback/v2");
  const maximumRequestBytes = integer(environment.FEEDBACK_MAXIMUM_REQUEST_BYTES ?? "8388608", "FEEDBACK_MAXIMUM_REQUEST_BYTES", 1024, 1_073_741_824);
  const operationTimeoutMilliseconds = integer(environment.FEEDBACK_OPERATION_TIMEOUT_MILLISECONDS ?? "30000", "FEEDBACK_OPERATION_TIMEOUT_MILLISECONDS", 100, 60_000);
  const configuration = await loadFeedbackConfigurationFromEnvironment({ environment });
  const [catalog, profiles] = await Promise.all([
    loadFeedbackConnectorCatalog(connectorProfilesFile),
    configuration.profileLoader.loadProfiles()
  ]);
  validateConnectorCatalogBindings(catalog, profiles);
  profiles.forEach((profile) => validateCapabilityDrift(profile, catalog));
  const byProfileId = new Map(profiles.map((profile) => [profile.profileId, profile]));
  const projectionVerifier = createProductionFeedbackProjectionVerifier({
    catalog,
    async loadCodec(profileId) {
      const profile = byProfileId.get(profileId);
      if (!profile) throw new Error(`provider profileがありません: ${profileId}`);
      return loadFeedbackEnvelopeCodec(configuration.secretResolver, profile.secretRefs.envelopeKeyRing.id);
    }
  });
  const service = createFeedbackService({
    configuration,
    connectors: new Map(),
    projectionVerifier,
    expectedOrigin,
    basePath,
    maximumRequestBytes,
    operationTimeoutMilliseconds,
    ...(input.authorizationHttpClient ? { httpClient: input.authorizationHttpClient } : {}),
    async repositoryResolver(resolution) {
      const reference = resolution.profile.connectorProfileRef;
      const runtimeProfile = reference ? catalog.profiles.get(reference) : undefined;
      if (!runtimeProfile || runtimeProfile.connectorKey !== resolution.profile.connectorKey) {
        throw new FeedbackGatewayProblem({
          code: "feedback.provider_unavailable",
          status: 502,
          retryable: false,
          message: "Connector runtime profile bindingが不正です"
        });
      }
      if (resolution.authorization.mode === "public-profile" &&
          resolution.authorization.allowedOperations.some((operation) => operation !== "feedback:read") &&
          !resolution.participantPrincipal) {
        throw new FeedbackGatewayProblem({ code: "feedback.forbidden", status: 403, message: "public write participantがありません" });
      }
      const participantId = await participantIdForAuthorization({
        decision: resolution.authorization,
        publicParticipantId: resolution.participantPrincipal?.participantId ?? null,
        profileId: resolution.profile.profileId,
        derivationSecretId: resolution.profile.secretRefs.participantIdDerivationKey.id,
        secretResolver: configuration.secretResolver
      });
      const [credential, envelopeCodec] = await Promise.all([
        resolveProviderAuthorization({
          secretResolver: configuration.secretResolver,
          secretId: resolution.profile.secretRefs.providerCredential.id,
          connectorKey: runtimeProfile.connectorKey
        }),
        loadFeedbackEnvelopeCodec(configuration.secretResolver, resolution.profile.secretRefs.envelopeKeyRing.id)
      ]);
      return createRepository({
        runtimeProfile,
        profile: resolution.profile,
        participantId,
        credential,
        envelopeCodec,
        jiraFetch: input.jiraFetch ?? nodeJiraCloudFetch,
        redmineFetch: input.redmineFetch ?? nodeRedmineFetch
      });
    }
  });
  return Object.freeze({
    service,
    catalog,
    profiles,
    expectedOrigin,
    basePath,
    hasRemoteAuthorizationProfiles: profiles.some((profile) => profile.authorization.mode === "remote-authorization")
  });
}

function createRepository(input: {
  runtimeProfile: FeedbackConnectorRuntimeProfile;
  profile: FeedbackProviderProfileV2;
  participantId: string;
  credential: string;
  envelopeCodec: Awaited<ReturnType<typeof loadFeedbackEnvelopeCodec>>;
  jiraFetch: JiraCloudFetch;
  redmineFetch: RedmineFetch;
}): FeedbackRepositoryPort {
  if (input.runtimeProfile.connectorKey === "jira-cloud") {
    return createFeedbackJiraCloudConnector({
      configuration: {
        profileId: input.profile.profileId,
        installationId: input.profile.installationId,
        application: input.runtimeProfile.application,
        environment: input.runtimeProfile.environment,
        participantId: input.participantId,
        issueTypeId: input.runtimeProfile.issueTypeId,
        maximumAttachmentBytes: input.runtimeProfile.maximumAttachmentBytes,
        attachmentContentTypes: input.runtimeProfile.attachmentContentTypes,
        pageSize: input.runtimeProfile.pageSize,
        recoveryRetryAfterSeconds: input.runtimeProfile.recoveryRetryAfterSeconds
      },
      transport: createJiraCloudFetchTransport({
        baseUrl: input.runtimeProfile.siteUrl,
        authorization: input.credential,
        fetch: input.jiraFetch,
        timeoutMilliseconds: input.runtimeProfile.timeoutMilliseconds
      }),
      envelopeCodec: input.envelopeCodec
    });
  }
  return createFeedbackRedmineConnector({
    profile: {
      profileId: input.profile.profileId,
      installationId: input.profile.installationId,
      displayName: input.profile.displayName,
      applicationKey: input.runtimeProfile.applicationKey,
      environmentKey: input.runtimeProfile.environmentKey,
      workspaceId: input.runtimeProfile.workspaceId,
      workspaceDisplayName: input.runtimeProfile.workspaceDisplayName,
      projectId: input.runtimeProfile.projectId,
      trackerId: input.runtimeProfile.trackerId,
      isPrivate: input.runtimeProfile.isPrivate,
      ...(input.runtimeProfile.defaultPriorityId ? { defaultPriorityId: input.runtimeProfile.defaultPriorityId } : {}),
      participantId: input.participantId,
      participantDisplayName: "Feedback participant",
      customFieldIds: input.runtimeProfile.customFieldIds,
      maximumAttachmentBytes: input.runtimeProfile.maximumAttachmentBytes,
      attachmentContentTypes: input.runtimeProfile.attachmentContentTypes
    },
    transport: createFeedbackRedmineRestTransport({
      baseUrl: input.runtimeProfile.baseUrl,
      apiKey: input.credential,
      fetch: input.redmineFetch
    }),
    envelopeCodec: input.envelopeCodec
  });
}

function validateCapabilityDrift(profile: FeedbackProviderProfileV2, catalog: FeedbackConnectorCatalog): void {
  const runtime = profile.connectorProfileRef ? catalog.profiles.get(profile.connectorProfileRef) : undefined;
  if (!runtime) throw new Error(`Connector runtime profileがありません: ${profile.profileId}`);
  const backendGuarantees = {
    create: "recoverable",
    reply: "recoverable",
    revision: "best-effort",
    attachmentUpload: "best-effort"
  } as const;
  for (const operation of Object.keys(backendGuarantees) as Array<keyof typeof backendGuarantees>) {
    const backend = backendGuarantees[operation];
    const configured = profile.capabilities.operationGuarantees[operation];
    const allowed = backend === "recoverable"
      ? new Set(["recoverable", "best-effort", "unsupported"])
      : new Set(["best-effort", "unsupported"]);
    if (!allowed.has(configured)) {
      throw new Error(`operation guaranteeがConnector実装より強く設定されています: ${profile.profileId}:${operation}`);
    }
  }
  const backendOperations = new Set([
    "feedback:read", "feedback:create", "feedback:reply", "feedback:revise",
    "feedback:attachment:read", "feedback:attachment:upload"
  ]);
  if (profile.capabilities.operations.some((operation) => !backendOperations.has(operation))) {
    throw new Error(`operation capabilityがConnector実装とdriftしています: ${profile.profileId}`);
  }
  if (runtime.maximumAttachmentBytes < 1 || runtime.attachmentContentTypes.length === 0) {
    throw new Error(`attachment設定が不正です: ${profile.profileId}`);
  }
}

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name}がありません`);
  return value;
}

function origin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("FEEDBACK_PUBLIC_ORIGINが不正です"); }
  if (url.origin !== value || !new Set(["https:", "http:"]).has(url.protocol) || url.username || url.password) {
    throw new Error("FEEDBACK_PUBLIC_ORIGINはoriginだけを指定してください");
  }
  return value;
}

function basePathValue(value: string): string {
  if (!/^\/[A-Za-z0-9/_-]+$/u.test(value) || value.endsWith("/") || value.includes("//")) {
    throw new Error("FEEDBACK_SERVICE_BASE_PATHが不正です");
  }
  return value;
}

function integer(value: string, name: string, minimum: number, maximum: number): number {
  if (!/^[0-9]+$/u.test(value)) throw new Error(`${name}が整数ではありません`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error(`${name}が範囲外です`);
  return result;
}
