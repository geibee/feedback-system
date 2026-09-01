import type { FeedbackProviderProfileV2, FeedbackServiceSettingsV2 } from "@geibee/feedback-contracts/v2/server";
import {
  createFeedbackHttpClient,
  type FeedbackHttpRequest,
  type FeedbackHttpResponse,
  type FeedbackHttpTransport
} from "@geibee/feedback-client";
import {
  createFeedbackJiraCloudConnector,
  jiraCloudRecoveryPropertyKey,
  type JiraCloudRequest,
  type JiraCloudResponse,
  type JiraCloudTransport
} from "@geibee/feedback-connector-jira-cloud";
import { calculateFeedbackCommandHash, createFeedbackEnvelopeCodec } from "@geibee/feedback-envelope";
import { createFeedbackService } from "@geibee/feedback-service";
import {
  createProductionFeedbackProjectionVerifier,
  type FeedbackConnectorCatalog,
  type JiraCloudRuntimeProfile
} from "@geibee/feedback-service-runtime";
import { describe, expect, it } from "vitest";

const origin = "https://app.example";
const profileId = "jira-public";
const installationId = "jira-site-test";
const runtimeProfileId = "jira-runtime-test";
const workspaceId = "FBT";
const resource = { kind: "record", key: "component-10001" } as const;
const threadId = "018f0f58-c3d1-7a2b-8a4f-4c09571e7001";
const intentId = "018f0f58-c3d1-7a2b-8a4f-4c09571e7002";
const browserProfileId = "018f0f58-c3d1-7a2b-8a4f-4c09571e7003";
const createdAt = "2026-09-01T00:00:00.000Z";

const envelopeKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const participantKey = Uint8Array.from({ length: 32 }, (_, index) => 100 + index);
const derivationKey = Uint8Array.from({ length: 32 }, (_, index) => 200 + index);

const profile: FeedbackProviderProfileV2 = {
  schemaVersion: "2",
  profileId,
  displayName: "Jira public acceptance",
  connectorKey: "jira-cloud",
  installationId,
  connectorProfileRef: runtimeProfileId,
  workspacePolicy: {
    workspaceIds: [workspaceId],
    workspaceDiscovery: "supported",
    resourceDiscovery: "supported"
  },
  authorization: { mode: "public-profile" },
  policy: {
    operations: ["feedback:read", "feedback:create"],
    resourceKinds: ["record"]
  },
  capabilities: {
    operations: ["feedback:read", "feedback:create"],
    discovery: { workspaces: "supported", resources: "supported" },
    operationGuarantees: {
      create: "recoverable",
      reply: "recoverable",
      revision: "best-effort",
      attachmentUpload: "best-effort"
    },
    creationFields: [],
    maximumMetadataBytes: 32_768,
    projectionValidation: "envelope-required",
    uniqueThreadLookup: true
  },
  secretRefs: {
    providerCredential: { kind: "server-secret", id: "PROVIDER" },
    envelopeKeyRing: { kind: "server-secret", id: "ENVELOPE_RING" },
    participantCredentialKeyRing: { kind: "server-secret", id: "PARTICIPANT_RING" },
    participantIdDerivationKey: { kind: "server-secret", id: "DERIVATION_KEY" }
  }
};

const settings: FeedbackServiceSettingsV2 = {
  schemaVersion: "2",
  serviceId: "provider-acceptance",
  profileFiles: ["/profiles/jira-public.json"],
  signedGrantIssuers: [],
  remoteAuthorizationProfiles: [],
  jwksCache: { maximumIssuers: 1, maximumKeysPerIssuer: 1, maximumTtlSeconds: 1 }
};

const runtimeProfile: JiraCloudRuntimeProfile = {
  id: runtimeProfileId,
  connectorKey: "jira-cloud",
  siteUrl: "https://example.atlassian.net",
  application: "inventory",
  environment: "acceptance",
  issueTypeId: "10001",
  maximumAttachmentBytes: 1024,
  attachmentContentTypes: ["text/plain"],
  timeoutMilliseconds: 1000,
  pageSize: 50,
  recoveryRetryAfterSeconds: 1
};

const catalog: FeedbackConnectorCatalog = {
  schemaVersion: "1",
  profiles: new Map([[runtimeProfile.id, runtimeProfile]])
};

class InMemoryJiraCloudTransport implements JiraCloudTransport {
  readonly requests: JiraCloudRequest[] = [];
  createCalls = 0;
  searchCalls = 0;
  recoveryProperty: unknown;
  createdBody: unknown;

  async request(request: JiraCloudRequest): Promise<JiraCloudResponse> {
    this.requests.push(request);
    if (request.method === "POST" && request.path === "/rest/api/3/issue?returnIssue=true") {
      this.createCalls += 1;
      const create = record(jsonBody(request), "create issue request");
      const fields = record(create.fields, "create issue fields");
      const properties = array(create.properties, "create issue properties");
      const recovery = properties
        .map((entry) => record(entry, "create issue property"))
        .find((entry) => entry.key === jiraCloudRecoveryPropertyKey);
      if (!recovery) throw new Error("recovery propertyがcreate requestにありません");
      this.recoveryProperty = recovery.value;
      this.createdBody = fields.description;
      // Jiraがissueを保存した後にresponseを失った状態を再現する。
      return response(503, { errorMessages: ["synthetic result unknown"] });
    }
    if (request.method === "POST" && request.path === "/rest/api/3/search/jql") {
      this.searchCalls += 1;
      // create直後の一度だけprojection indexを不可視にして明示回収へ進ませる。
      return response(200, {
        issues: this.searchCalls === 1 ? [] : [this.issue(true)],
        isLast: true
      });
    }
    if (request.method === "GET" && request.path === this.propertyPath()) {
      return response(200, { value: this.recoveryProperty });
    }
    if (request.method === "PUT" && request.path === this.propertyPath()) {
      this.recoveryProperty = jsonBody(request);
      return response(204, null);
    }
    if (request.method === "GET" && request.path.startsWith("/rest/api/3/issue/10001?")) {
      return response(200, this.issue(false));
    }
    if (request.method === "GET" && request.path.startsWith("/rest/api/3/issue/10001/comment?")) {
      return response(200, { comments: [], startAt: 0, maxResults: 50, total: 0 });
    }
    if (request.method === "GET" && request.path === "/rest/api/3/issue/10001/properties") {
      return response(200, { keys: [{ key: jiraCloudRecoveryPropertyKey }] });
    }
    throw new Error(`unexpected Jira request: ${request.method} ${request.path}`);
  }

  private propertyPath(): string {
    return `/rest/api/3/issue/10001/properties/${encodeURIComponent(jiraCloudRecoveryPropertyKey)}`;
  }

  private issue(withProjection: boolean): Record<string, unknown> {
    return {
      id: "10001",
      key: "FBT-1",
      fields: {
        summary: "Inventory feedback",
        description: this.createdBody,
        status: { statusCategory: { key: "new" } },
        created: createdAt,
        updated: createdAt
      },
      ...(withProjection ? { properties: { [jiraCloudRecoveryPropertyKey]: this.recoveryProperty } } : {})
    };
  }
}

class FeedbackServiceTransport implements FeedbackHttpTransport {
  readonly requests: FeedbackHttpRequest[] = [];

  constructor(private readonly handle: (request: Request) => Promise<Response>) {}

  async request(request: FeedbackHttpRequest): Promise<FeedbackHttpResponse> {
    this.requests.push(request);
    if (request.body !== undefined && typeof request.body !== "string") {
      throw new Error("このacceptanceではJSON requestだけを使用します");
    }
    const headers = new Headers(request.headers);
    if (request.method === "POST") headers.set("Origin", origin);
    const providerResponse = await this.handle(new Request(`${origin}${request.path}`, {
      method: request.method,
      headers,
      ...(request.body === undefined ? {} : { body: request.body })
    }));
    const responseHeaders: Record<string, string> = {};
    providerResponse.headers.forEach((value, key) => { responseHeaders[key] = value; });
    return {
      status: providerResponse.status,
      headers: responseHeaders,
      json: () => providerResponse.json(),
      dispose: () => providerResponse.body?.cancel()
    };
  }
}

describe("Feedback client/service/Jira actual integration acceptance", () => {
  it("public credential付きcreateの結果不明をintent回収し、検証済み本文をreadする", async () => {
    const jira = new InMemoryJiraCloudTransport();
    const envelopeCodec = createFeedbackEnvelopeCodec([{
      kid: "envelope-current",
      secret: envelopeKey,
      state: "active"
    }]);
    const secrets: Readonly<Record<string, string>> = {
      PROVIDER: JSON.stringify({ kind: "jira-cloud-basic", email: "feedback@example.com", apiToken: "test-token" }),
      ENVELOPE_RING: signingRing("envelope-current", envelopeKey),
      PARTICIPANT_RING: signingRing("participant-current", participantKey),
      DERIVATION_KEY: base64url(derivationKey)
    };
    const projectionVerifier = createProductionFeedbackProjectionVerifier({
      catalog,
      async loadCodec() { return envelopeCodec; }
    });
    const service = createFeedbackService({
      configuration: {
        settings,
        profileLoader: { async loadProfiles() { return [profile]; } },
        secretResolver: {
          async resolve(id) {
            const secret = secrets[id];
            if (secret === undefined) throw new Error(`missing secret: ${id}`);
            return secret;
          }
        }
      },
      connectors: new Map(),
      projectionVerifier,
      expectedOrigin: origin,
      maximumRequestBytes: 16_384,
      operationTimeoutMilliseconds: 1000,
      repositoryResolver({ participantPrincipal }) {
        if (!participantPrincipal) throw new Error("participant credentialがrequest-scoped Connectorへ束縛されていません");
        return createFeedbackJiraCloudConnector({
          configuration: {
            profileId,
            installationId,
            application: runtimeProfile.application,
            environment: runtimeProfile.environment,
            participantId: participantPrincipal.participantId,
            issueTypeId: runtimeProfile.issueTypeId,
            maximumAttachmentBytes: runtimeProfile.maximumAttachmentBytes,
            attachmentContentTypes: runtimeProfile.attachmentContentTypes,
            pageSize: runtimeProfile.pageSize,
            recoveryRetryAfterSeconds: runtimeProfile.recoveryRetryAfterSeconds
          },
          transport: jira,
          envelopeCodec,
          now: () => new Date(createdAt)
        });
      }
    });
    const http = new FeedbackServiceTransport((request) => service.handle(request));
    let participantCredential: string | undefined;
    const client = createFeedbackHttpClient({
      transport: http,
      credentialProvider: () => participantCredential === undefined
        ? undefined
        : { participantCredential }
    });

    const participant = await client.issueParticipant({ profileId, browserProfileId });
    participantCredential = participant.credential;

    const title = "Inventory feedback";
    const body = "Create response was lost, but this provider body is authoritative.";
    const commandWithoutHash = { intentId, threadId, resource, title, body };
    const requestHash = calculateFeedbackCommandHash(commandWithoutHash);
    const pending = await client.createThread({
      profileId,
      workspaceId,
      command: { ...commandWithoutHash, requestHash }
    });
    expect(pending).toEqual({
      intentId,
      state: "pending",
      operation: "feedback:create",
      retryAfterSeconds: 1,
      automaticWriteAllowed: false
    });
    expect(jira.createCalls).toBe(1);

    const recovered = await client.recoverIntent({
      profileId,
      workspaceId,
      resource,
      threadId,
      intentId,
      requestHash,
      operation: "feedback:create"
    });
    expect(recovered).toEqual({
      intentId,
      state: "completed",
      operation: "feedback:create",
      stableResultId: threadId
    });
    expect(jira.createCalls).toBe(1);

    const thread = await client.getThread({ profileId, workspaceId, resource, threadId });
    expect(thread).toMatchObject({
      threadId,
      resource,
      title,
      messageCount: 1,
      messages: [{
        messageId: threadId,
        body,
        author: {
          kind: "participant",
          participantId: participant.participantId,
          isCurrentParticipant: true
        }
      }]
    });
    expect(jira.recoveryProperty).toMatchObject({
      threadId,
      intentId,
      requestHash,
      state: "bound",
      envelope: {
        threadId,
        intentId,
        requestHash,
        providerBinding: { profileId, installationId, objectId: "10001" },
        scope: { workspace: workspaceId, resource }
      }
    });
    expect(http.requests.find((request) => request.path.endsWith("/threads"))?.headers)
      .toMatchObject({ "X-Feedback-Participant-Credential": participant.credential });
    expect(jira.searchCalls).toBe(3);
  });
});

function response(status: number, body: unknown): JiraCloudResponse {
  return { status, headers: {}, body };
}

function jsonBody(request: JiraCloudRequest): unknown {
  if (request.body?.kind !== "json") throw new Error("Jira JSON bodyがありません");
  return request.body.value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}がobjectではありません`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}がarrayではありません`);
  return value;
}

function signingRing(kid: string, key: Uint8Array): string {
  return JSON.stringify({ activeKid: kid, keys: [{ kid, key: base64url(key) }] });
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}
