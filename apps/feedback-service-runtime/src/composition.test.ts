import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFeedbackProductionRuntime } from "./composition.js";
import { createFeedbackNodeServer } from "./listener.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Feedback Service production composition", () => {
  it("read-only設定からJira request-scoped Connectorを生成し、provider接続なしでprofile能力を返す", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedback-runtime-"));
    directories.push(directory);
    const profileFile = join(directory, "profile.json");
    const settingsFile = join(directory, "settings.json");
    const catalogFile = join(directory, "connectors.json");
    const key = Buffer.alloc(32, 4).toString("base64url");
    const ring = JSON.stringify({ activeKid: "current", keys: [{ kid: "current", key }] });
    const writableProfile = providerProfile();
    writableProfile.policy.operations.push("feedback:create");
    await writeFile(profileFile, JSON.stringify(writableProfile), { mode: 0o600 });
    await writeFile(settingsFile, JSON.stringify({
      schemaVersion: "2",
      serviceId: "phase5-test",
      profileFiles: [profileFile],
      signedGrantIssuers: [],
      remoteAuthorizationProfiles: [],
      jwksCache: { maximumIssuers: 1, maximumKeysPerIssuer: 1, maximumTtlSeconds: 60 }
    }), { mode: 0o600 });
    await writeFile(catalogFile, JSON.stringify({ schemaVersion: "1", profiles: [jiraRuntimeProfile()] }), { mode: 0o600 });
    const jiraFetch = vi.fn(async () => { throw new Error("profile capabilityでproviderへ接続してはいけません"); });
    const runtime = await createFeedbackProductionRuntime({
      environment: {
        FEEDBACK_SERVICE_SETTINGS_FILE: settingsFile,
        FEEDBACK_CONNECTOR_PROFILES_FILE: catalogFile,
        FEEDBACK_PUBLIC_ORIGIN: "https://app.example",
        PROVIDER: JSON.stringify({ kind: "jira-cloud-basic", email: "tester@example.test", apiToken: "token" }),
        ENVELOPE: ring,
        PARTICIPANT: ring,
        DERIVATION: key
      },
      jiraFetch
    });

    await expect(runtime.service.readiness()).resolves.toEqual({ ready: true, profileCount: 1 });
    const response = await runtime.service.handle(new Request(
      "https://app.example/internal/feedback/v2/profiles/jira?workspaceId=FBT&resourceKind=record&resourceKey=order-001"
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      profile: { profileId: "jira", effectivePermissions: ["feedback:read", "feedback:create"] }
    });
    expect(jiraFetch).not.toHaveBeenCalled();
  });

  it("read-only設定からRedmine request-scoped Connectorも同じServiceへ接続する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedback-runtime-redmine-"));
    directories.push(directory);
    const profileFile = join(directory, "profile.json");
    const settingsFile = join(directory, "settings.json");
    const catalogFile = join(directory, "connectors.json");
    const key = Buffer.alloc(32, 5).toString("base64url");
    const ring = JSON.stringify({ activeKid: "current", keys: [{ kid: "current", key }] });
    await writeFile(profileFile, JSON.stringify(redmineProviderProfile()), { mode: 0o600 });
    await writeFile(settingsFile, JSON.stringify({
      schemaVersion: "2", serviceId: "phase5-redmine", profileFiles: [profileFile],
      signedGrantIssuers: [], remoteAuthorizationProfiles: [],
      jwksCache: { maximumIssuers: 1, maximumKeysPerIssuer: 1, maximumTtlSeconds: 60 }
    }), { mode: 0o600 });
    await writeFile(catalogFile, JSON.stringify({ schemaVersion: "1", profiles: [redmineRuntimeProfile()] }), { mode: 0o600 });
    const redmineFetch = vi.fn(async () => { throw new Error("profile capabilityでproviderへ接続してはいけません"); });
    const runtime = await createFeedbackProductionRuntime({
      environment: {
        FEEDBACK_SERVICE_SETTINGS_FILE: settingsFile,
        FEEDBACK_CONNECTOR_PROFILES_FILE: catalogFile,
        FEEDBACK_PUBLIC_ORIGIN: "https://app.example",
        PROVIDER: JSON.stringify({ kind: "redmine-api-key", apiKey: "token" }),
        ENVELOPE: ring,
        PARTICIPANT: ring,
        DERIVATION: key
      },
      redmineFetch
    });
    const response = await runtime.service.handle(new Request(
      "https://app.example/internal/feedback/v2/profiles/redmine?workspaceId=FBT&resourceKind=record&resourceKey=order-001"
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ profile: { profileId: "redmine" } });
    expect(redmineFetch).not.toHaveBeenCalled();
  });

  it("Backlogも同じadapter registryでcredentialとcapabilityを解決する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedback-runtime-backlog-"));
    directories.push(directory);
    const profileFile = join(directory, "profile.json");
    const settingsFile = join(directory, "settings.json");
    const catalogFile = join(directory, "connectors.json");
    const key = Buffer.alloc(32, 6).toString("base64url");
    const ring = JSON.stringify({ activeKid: "current", keys: [{ kid: "current", key }] });
    await writeFile(profileFile, JSON.stringify(backlogProviderProfile()), { mode: 0o600 });
    await writeFile(settingsFile, JSON.stringify({
      schemaVersion: "2", serviceId: "stage-b-backlog", profileFiles: [profileFile],
      signedGrantIssuers: [], remoteAuthorizationProfiles: [],
      jwksCache: { maximumIssuers: 1, maximumKeysPerIssuer: 1, maximumTtlSeconds: 60 }
    }), { mode: 0o600 });
    await writeFile(catalogFile, JSON.stringify({ schemaVersion: "1", profiles: [backlogRuntimeProfile()] }), { mode: 0o600 });
    const backlogFetch = vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      const body = path === "/api/v2/projects/1"
        ? { id: 1, projectKey: "FBSTAGEA", name: "Feedback", archived: false }
        : path === "/api/v2/projects/1/customFields"
          ? [
            { id: 11, typeId: 1, name: "feedback.threadId", required: false },
            { id: 12, typeId: 1, name: "feedback.intentId", required: false },
            { id: 13, typeId: 1, name: "feedback.requestHash", required: false },
            { id: 14, typeId: 1, name: "feedback.resourceKey", required: false }
          ]
          : path === "/api/v2/projects/1/issueTypes"
            ? [{ id: 2, name: "Task" }]
            : [{ id: 3, name: "Normal" }];
      return { status: 200, headers: new Headers({ "content-type": "application/json" }), async text() { return JSON.stringify(body); } };
    });
    const runtime = await createFeedbackProductionRuntime({
      environment: {
        FEEDBACK_SERVICE_SETTINGS_FILE: settingsFile,
        FEEDBACK_CONNECTOR_PROFILES_FILE: catalogFile,
        FEEDBACK_PUBLIC_ORIGIN: "https://app.example",
        PROVIDER: JSON.stringify({ kind: "backlog-api-key", apiKey: "token" }),
        ENVELOPE: ring,
        PARTICIPANT: ring,
        DERIVATION: key
      },
      backlogFetch
    });
    await expect(runtime.service.readiness()).resolves.toEqual({ ready: true, profileCount: 1 });
    const response = await runtime.service.handle(new Request(
      "https://app.example/internal/feedback/v2/profiles/backlog?workspaceId=FBSTAGEA&resourceKind=record&resourceKey=order-001"
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      profile: {
        profileId: "backlog",
        effectivePermissions: ["feedback:read"],
        capabilities: { discovery: { resources: "unsupported" } }
      }
    });
    expect(backlogFetch).not.toHaveBeenCalled();
    backlogFetch.mockRejectedValue(new Error("一時的なprovider障害"));
    await expect(runtime.service.readiness()).resolves.toEqual({ ready: true, profileCount: 1 });
    expect(backlogFetch).not.toHaveBeenCalled();
  });

  it("remote-authorization profileを認証済みsubject adapterなしでlistenさせない", () => {
    expect(() => createFeedbackNodeServer({
      runtime: {
        hasRemoteAuthorizationProfiles: true
      } as never
    })).toThrow("認証済みsubject adapter");
  });
});

function providerProfile() {
  return {
    schemaVersion: "2",
    profileId: "jira",
    displayName: "Jira",
    connectorKey: "jira-cloud",
    installationId: "site-1",
    connectorProfileRef: "jira-runtime",
    workspacePolicy: { workspaceIds: ["FBT"], workspaceDiscovery: "supported", resourceDiscovery: "supported" },
    authorization: { mode: "public-profile" },
    policy: { operations: ["feedback:read"], resourceKinds: ["record"] },
    capabilities: {
      operations: ["feedback:read", "feedback:create", "feedback:reply", "feedback:revise", "feedback:attachment:read", "feedback:attachment:upload"],
      discovery: { workspaces: "supported", resources: "supported" },
      operationGuarantees: { create: "recoverable", reply: "recoverable", revision: "best-effort", attachmentUpload: "best-effort" },
      creationFields: [],
      maximumMetadataBytes: 32768,
      projectionValidation: "envelope-required",
      uniqueThreadLookup: true
    },
    secretRefs: {
      providerCredential: { kind: "server-secret", id: "PROVIDER" },
      envelopeKeyRing: { kind: "server-secret", id: "ENVELOPE" },
      participantCredentialKeyRing: { kind: "server-secret", id: "PARTICIPANT" },
      participantIdDerivationKey: { kind: "server-secret", id: "DERIVATION" }
    }
  };
}

function jiraRuntimeProfile() {
  return {
    id: "jira-runtime",
    connectorKey: "jira-cloud",
    siteUrl: "https://example.atlassian.net",
    application: "inventory",
    environment: "production",
    issueTypeId: "10001",
    maximumAttachmentBytes: 1024,
    attachmentContentTypes: ["text/plain"],
    timeoutMilliseconds: 1000,
    pageSize: 50,
    recoveryRetryAfterSeconds: 10
  };
}

function redmineProviderProfile() {
  return {
    ...providerProfile(),
    profileId: "redmine",
    displayName: "Redmine",
    connectorKey: "redmine",
    installationId: "redmine-1",
    connectorProfileRef: "redmine-runtime"
  };
}

function redmineRuntimeProfile() {
  return {
    id: "redmine-runtime",
    connectorKey: "redmine",
    baseUrl: "https://redmine.example.test",
    application: "inventory",
    environment: "production",
    applicationKey: "inventory",
    environmentKey: "production",
    workspaceId: "FBT",
    workspaceDisplayName: "Feedback",
    projectId: 1,
    trackerId: 1,
    isPrivate: true,
    customFieldIds: {
      threadId: 1,
      intentId: 2,
      requestHash: 3,
      envelope: 4,
      projection: 5,
      applicationKey: 6,
      environmentKey: 7,
      externalWorkspaceKey: 8,
      hostResourceKey: 9
    },
    maximumAttachmentBytes: 1024,
    attachmentContentTypes: ["text/plain"]
  };
}

function backlogProviderProfile() {
  return {
    ...providerProfile(),
    profileId: "backlog",
    displayName: "Backlog",
    connectorKey: "backlog",
    installationId: "backlog-1",
    connectorProfileRef: "backlog-runtime",
    workspacePolicy: { workspaceIds: ["FBSTAGEA"], workspaceDiscovery: "supported", resourceDiscovery: "unsupported" },
    capabilities: {
      operations: ["feedback:read", "feedback:create", "feedback:reply", "feedback:revise"],
      discovery: { workspaces: "supported", resources: "unsupported" },
      operationGuarantees: { create: "recoverable", reply: "recoverable", revision: "recoverable", attachmentUpload: "unsupported" },
      creationFields: [], maximumMetadataBytes: 32768,
      projectionValidation: "envelope-required", uniqueThreadLookup: true
    }
  };
}

function backlogRuntimeProfile() {
  return {
    id: "backlog-runtime", connectorKey: "backlog", baseUrl: "https://example.backlog.com",
    application: "inventory", environment: "production", workspaceId: "FBSTAGEA",
    workspaceDisplayName: "Feedback", projectId: 1, issueTypeId: 2, priorityId: 3,
    maximumAttachmentBytes: 1, attachmentContentTypes: [], maximumMetadataBytes: 32768,
    timeoutMilliseconds: 30000, pageSize: 100, recoveryRetryAfterSeconds: 5,
    customFieldIds: { threadId: 11, intentId: 12, requestHash: 13, resourceKey: 14 }
  };
}
