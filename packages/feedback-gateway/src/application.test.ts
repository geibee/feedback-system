import type { FeedbackCapabilitiesV2 } from "@geibee/feedback-contracts/v2";
import type { FeedbackProviderProfileV2 } from "@geibee/feedback-contracts/v2/server";
import { createFakeFeedbackRepository } from "@geibee/feedback-connector-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import {
  FeedbackGatewayApplicationService,
  FeedbackGatewayProblem,
  createFakeFeedbackAuthorizationPort
} from "./index.js";

const resource = { kind: "record", key: "order-001" } as const;
const profile: FeedbackProviderProfileV2 = {
  schemaVersion: "2",
  profileId: "inventory",
  displayName: "Inventory",
  connectorKey: "fake",
  installationId: "fake-installation",
  workspacePolicy: { workspaceIds: ["OPS"], workspaceDiscovery: "supported", resourceDiscovery: "supported" },
  authorization: { mode: "public-profile" },
  policy: { operations: ["feedback:read", "feedback:create"], resourceKinds: ["record"] },
  capabilities: {
    operations: ["feedback:read", "feedback:create"],
    discovery: { workspaces: "supported", resources: "supported" },
    operationGuarantees: { create: "recoverable", reply: "unsupported", revision: "unsupported", attachmentUpload: "unsupported" },
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

const capabilities: FeedbackCapabilitiesV2 = {
  backendOperations: ["feedback:read", "feedback:create"],
  discovery: { workspaces: "supported" as const, resources: "supported" as const },
  operationGuarantees: { create: "recoverable" as const, reply: "unsupported" as const, revision: "unsupported" as const, attachmentUpload: "unsupported" as const },
  creationFields: [],
  maximumAttachmentBytes: 1024,
  attachmentContentTypes: ["text/plain"]
};

function service(repository = createFakeFeedbackRepository({ async getCapabilities() { return capabilities; } })) {
  const authorization = createFakeFeedbackAuthorizationPort("public-profile", async (request) => ({
    target: request.target,
    mode: "public-profile",
    allowedOperations: [...request.requestedOperations]
  }));
  return {
    repository,
    application: new FeedbackGatewayApplicationService({
      profileLoader: { async loadProfiles() { return [profile]; } },
      authorizationPorts: new Map([["public-profile", authorization]]),
      connectors: new Map([["fake", repository]]),
      projectionVerifier: { async verify() { return { valid: false as const, reason: "signature" as const }; } }
    })
  };
}

const access = { grant: { mode: "public-profile" as const, source: "profile-reachability" as const } };

describe("FeedbackGatewayApplicationService", () => {
  it("command resourceのIDORをConnector接続前に拒否する", async () => {
    const { application, repository } = service();
    await expect(application.createThread({
      profileId: "inventory",
      workspaceId: "OPS",
      resource,
      command: {
        intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5101",
        requestHash: `sha256:${"1".repeat(64)}`,
        threadId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5102",
        resource: { kind: "record", key: "other" },
        title: "title",
        body: "body"
      },
      access
    })).rejects.toMatchObject({ code: "feedback.invalid_request" });
    expect(repository.count("getCapabilities")).toBe(0);
    expect(repository.count("createThread")).toBe(0);
  });

  it("threadIdの複数候補を自動選択せずconflictにする", async () => {
    const repository = createFakeFeedbackRepository({
      async getCapabilities() { return capabilities; },
      async findThreadCandidatesById() { return [{}, {}] as never; }
    });
    const { application } = service(repository);
    await expect(application.getThread({
      profileId: "inventory",
      workspaceId: "OPS",
      resource,
      threadId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5102",
      access
    })).rejects.toMatchObject({ code: "feedback.conflict", status: 409 });
    expect(repository.count("readCandidate")).toBe(0);
  });

  it("projection検証に成功したthreadだけをbrowser DTOへ返す", async () => {
    const validThread = {
      threadId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5102",
      resource,
      title: "valid",
      status: "open" as const,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      messageCount: 1,
      messages: []
    };
    const candidates = [{ providerRef: { providerKey: "fake", objectId: "1" }, projection: {} }, { providerRef: { providerKey: "fake", objectId: "2" }, projection: {} }] as never;
    const repository = createFakeFeedbackRepository({
      async getCapabilities() { return capabilities; },
      async findThreadCandidates() { return { candidates, nextCursor: null }; },
      async readCandidate(candidate) { return { providerRef: candidate.providerRef, envelope: null, legacyMetadata: null, thread: validThread }; }
    });
    const verify = vi.fn(async (candidate: { providerRef: { objectId: string } }, read: unknown) => candidate.providerRef.objectId === "1"
      ? { valid: true as const, record: { providerRef: candidate.providerRef, envelope: {}, thread: validThread } as never }
      : { valid: false as const, reason: "signature" as const });
    const authorization = createFakeFeedbackAuthorizationPort("public-profile", async (request) => ({ target: request.target, mode: "public-profile", allowedOperations: ["feedback:read"] }));
    const application = new FeedbackGatewayApplicationService({
      profileLoader: { async loadProfiles() { return [profile]; } },
      authorizationPorts: new Map([["public-profile", authorization]]),
      connectors: new Map([["fake", repository]]),
      projectionVerifier: { verify: verify as never }
    });
    const page = await application.listThreads({ profileId: "inventory", workspaceId: "OPS", resource, access });
    expect(page.items).toEqual([expect.objectContaining({ title: "valid" })]);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("attachment upload権限をcreateから導出しない", async () => {
    const { application } = service();
    await expect(application.uploadAttachment({
      profileId: "inventory",
      workspaceId: "OPS",
      resource,
      threadId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5102",
      command: {
        intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5101",
        requestHash: `sha256:${"1".repeat(64)}`,
        attachmentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5103",
        filename: "evidence.txt",
        contentType: "text/plain",
        sizeBytes: 1,
        contentHash: `sha256:${"2".repeat(64)}`,
        purpose: "evidence"
      },
      source: { sizeBytes: 1, async *read() { yield new Uint8Array([1]); } },
      access
    })).rejects.toBeInstanceOf(FeedbackGatewayProblem);
  });

  it("認可成功後に検証済みdecisionとaccessでrequest-scoped Connectorを解決する", async () => {
    const repository = createFakeFeedbackRepository({ async getCapabilities() { return capabilities; } });
    const authorization = createFakeFeedbackAuthorizationPort("public-profile", async (request) => ({
      target: request.target,
      mode: "public-profile",
      allowedOperations: ["feedback:read"]
    }));
    const resolver = vi.fn(async () => repository);
    const application = new FeedbackGatewayApplicationService({
      profileLoader: { async loadProfiles() { return [profile]; } },
      authorizationPorts: new Map([["public-profile", authorization]]),
      connectors: new Map(),
      repositoryResolver: resolver,
      projectionVerifier: { async verify() { return { valid: false as const, reason: "signature" as const }; } }
    });

    await application.getProfile({ profileId: "inventory", workspaceId: "OPS", resource, access });

    expect(resolver).toHaveBeenCalledOnce();
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({
      profile,
      access,
      authorization: expect.objectContaining({ mode: "public-profile", allowedOperations: ["feedback:read"] })
    }));
  });

  it("公開profile能力をprofile設定とbackend能力の弱い側へ制限する", async () => {
    const restrictedProfile: FeedbackProviderProfileV2 = {
      ...profile,
      capabilities: {
        ...profile.capabilities,
        discovery: { workspaces: "unsupported", resources: "supported" },
        operationGuarantees: { ...profile.capabilities.operationGuarantees, create: "recoverable" },
        creationFields: [{ key: "kind", label: "Kind", type: "text", required: false }]
      }
    };
    const repository = createFakeFeedbackRepository({
      async getCapabilities() {
        return {
          ...capabilities,
          operationGuarantees: { ...capabilities.operationGuarantees, create: "best-effort" },
          creationFields: [
            { key: "kind", label: "Kind", type: "text" as const, required: false },
            { key: "internal", label: "Internal", type: "text" as const, required: false }
          ]
        };
      }
    });
    const authorization = createFakeFeedbackAuthorizationPort("public-profile", async (request) => ({
      target: request.target,
      mode: "public-profile",
      allowedOperations: ["feedback:read"]
    }));
    const application = new FeedbackGatewayApplicationService({
      profileLoader: { async loadProfiles() { return [restrictedProfile]; } },
      authorizationPorts: new Map([["public-profile", authorization]]),
      connectors: new Map([["fake", repository]]),
      projectionVerifier: { async verify() { return { valid: false as const, reason: "signature" as const }; } }
    });

    await expect(application.getProfile({ profileId: "inventory", workspaceId: "OPS", resource, access }))
      .resolves.toMatchObject({
        capabilities: {
          discovery: { workspaces: "unsupported", resources: "supported" },
          operationGuarantees: { create: "best-effort" },
          creationFields: [{ key: "kind" }]
        }
      });
  });

  it("Authorization Mode不一致ではrequest-scoped Connectorを呼ばない", async () => {
    const resolver = vi.fn(async () => createFakeFeedbackRepository());
    const application = new FeedbackGatewayApplicationService({
      profileLoader: { async loadProfiles() { return [profile]; } },
      authorizationPorts: new Map(),
      connectors: new Map(),
      repositoryResolver: resolver,
      projectionVerifier: { async verify() { return { valid: false as const, reason: "signature" as const }; } }
    });

    await expect(application.getProfile({
      profileId: "inventory",
      workspaceId: "OPS",
      resource,
      access: {
        grant: {
          mode: "signed-grant",
          source: "verified-jwt",
          subjectId: "subject",
          allowedOperations: ["feedback:read"],
          boundTarget: { level: "resource", profileId: "inventory", workspaceId: "OPS", resource }
        }
      }
    })).rejects.toMatchObject({ code: "feedback.unauthorized" });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("signed grantのworkspace／resource discoveryを束縛対象だけへ絞る", async () => {
    const signedProfile: FeedbackProviderProfileV2 = {
      ...profile,
      authorization: { mode: "signed-grant", issuerProfileRef: "issuer" },
      workspacePolicy: { ...profile.workspacePolicy, workspaceIds: ["OPS", "OTHER"] }
    };
    const repository = createFakeFeedbackRepository({
      async getCapabilities() { return capabilities; },
      async listWorkspaces() {
        return {
          items: [
            { workspaceId: "OPS", displayName: "Operations" },
            { workspaceId: "OTHER", displayName: "Other" }
          ],
          nextCursor: null
        };
      },
      async listResources() {
        return {
          items: [
            { resource, displayName: "Order 1" },
            { resource: { kind: "record", key: "order-002" }, displayName: "Order 2" }
          ],
          nextCursor: null
        };
      }
    });
    const authorization = createFakeFeedbackAuthorizationPort("signed-grant", async (request) => ({
      target: request.target,
      mode: "signed-grant",
      subjectId: "subject",
      allowedOperations: ["feedback:read"]
    }));
    const application = new FeedbackGatewayApplicationService({
      profileLoader: { async loadProfiles() { return [signedProfile]; } },
      authorizationPorts: new Map([["signed-grant", authorization]]),
      connectors: new Map([["fake", repository]]),
      projectionVerifier: { async verify() { return { valid: false as const, reason: "signature" as const }; } }
    });
    const signedAccess = {
      grant: {
        mode: "signed-grant" as const,
        source: "verified-jwt" as const,
        subjectId: "subject",
        allowedOperations: ["feedback:read" as const],
        boundTarget: { level: "resource" as const, profileId: "inventory", workspaceId: "OPS", resource }
      }
    };

    await expect(application.listWorkspaces({ profileId: "inventory", access: signedAccess }))
      .resolves.toMatchObject({ items: [{ workspaceId: "OPS" }] });
    await expect(application.listResources({ profileId: "inventory", workspaceId: "OPS", access: signedAccess }))
      .resolves.toMatchObject({ items: [{ resource }] });
  });
});
