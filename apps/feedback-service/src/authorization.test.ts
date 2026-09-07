import { generateKeyPairSync, sign } from "node:crypto";
import type { FeedbackProviderProfileV2, FeedbackServiceSettingsV2 } from "@geibee/feedback-contracts/v2/server";
import { describe, expect, it, vi } from "vitest";
import { createFeedbackAuthorizationRuntime, type FeedbackHttpClientPort } from "./authorization.js";

const target = {
  level: "resource",
  profileId: "signed",
  workspaceId: "OPS",
  resource: { kind: "record", key: "order-001" }
} as const;

const baseProfile: Omit<FeedbackProviderProfileV2, "authorization" | "profileId"> = {
  schemaVersion: "2",
  displayName: "Signed",
  connectorKey: "fake",
  installationId: "fake",
  workspacePolicy: { workspaceIds: ["OPS"], workspaceDiscovery: "supported", resourceDiscovery: "supported" },
  policy: { operations: ["feedback:read", "feedback:create"], resourceKinds: ["record"] },
  capabilities: {
    operations: ["feedback:read", "feedback:create"],
    discovery: { workspaces: "supported", resources: "supported" },
    operationGuarantees: { create: "recoverable", reply: "unsupported", revision: "unsupported", attachmentUpload: "unsupported" },
    creationFields: [], maximumMetadataBytes: 32768, projectionValidation: "envelope-required", uniqueThreadLookup: true
  },
  secretRefs: {
    providerCredential: { kind: "server-secret", id: "PROVIDER" },
    envelopeKeyRing: { kind: "server-secret", id: "ENVELOPE" },
    participantCredentialKeyRing: { kind: "server-secret", id: "PARTICIPANT" },
    participantIdDerivationKey: { kind: "server-secret", id: "DERIVATION" }
  }
};

const settings: FeedbackServiceSettingsV2 = {
  schemaVersion: "2",
  serviceId: "feedback-test",
  profileFiles: ["/profile.json"],
  signedGrantIssuers: [{
    id: "issuer",
    issuer: "https://issuer.example/",
    jwksUri: "https://issuer.example/jwks",
    algorithm: "RS256",
    grant: { grantKind: "oidc", clientId: "feedback-browser" }
  }],
  remoteAuthorizationProfiles: [],
  jwksCache: { maximumIssuers: 2, maximumKeysPerIssuer: 4, maximumTtlSeconds: 60 }
};

describe("signed-grant Authorization Mode", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "current", use: "sig", alg: "RS256" };
  const profile: FeedbackProviderProfileV2 = { ...baseProfile, profileId: "signed", authorization: { mode: "signed-grant", issuerProfileRef: "issuer" } };
  const now = 1_788_220_800;

  function token(overrides: Record<string, unknown> = {}, kid = "current"): string {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: "https://issuer.example/",
      sub: "opaque-subject",
      aud: "urn:geibee:feedback-service:feedback-test",
      iat: now,
      exp: now + 300,
      scope: "feedback:read feedback:create",
      feedback_grant_kind: "oidc",
      feedback_profile_id: "signed",
      feedback_workspace_id: "OPS",
      feedback_resource: { kind: "record", key: "order-001" },
      azp: "feedback-browser",
      ...overrides
    })).toString("base64url");
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`, "ascii"), privateKey).toString("base64url");
    return `${header}.${payload}.${signature}`;
  }

  function runtime(httpClient?: FeedbackHttpClientPort) {
    return createFeedbackAuthorizationRuntime({
      settings,
      profileLoader: { async loadProfiles() { return [profile]; } },
      secretResolver: { async resolve() { throw new Error("unexpected secret"); } },
      httpClient: httpClient ?? { async request() { return { status: 200, headers: { "content-type": "application/json", "cache-control": "max-age=60" }, body: JSON.stringify({ keys: [jwk] }) }; } },
      nowMilliseconds: () => now * 1000
    });
  }

  it("署名、単一audience、寿命、scope、request targetを完全一致で検証する", async () => {
    const authorization = runtime();
    const access = await authorization.createAccess({
      profileId: "signed",
      target,
      requestedOperations: ["feedback:read"],
      bearerToken: token()
    });
    expect(access.grant).toMatchObject({ mode: "signed-grant", subjectId: "opaque-subject" });
    await expect(authorization.createAccess({
      profileId: "signed", target, requestedOperations: ["feedback:read"], bearerToken: token({ aud: ["urn:geibee:feedback-service:feedback-test"] })
    })).rejects.toMatchObject({ code: "feedback.unauthorized" });
    await expect(authorization.createAccess({
      profileId: "signed", target, requestedOperations: ["feedback:read"], bearerToken: token({ exp: now + 301 })
    })).rejects.toMatchObject({ code: "feedback.unauthorized" });
    await expect(authorization.createAccess({
      profileId: "signed", target: { ...target, resource: { kind: "record", key: "other" } }, requestedOperations: ["feedback:read"], bearerToken: token()
    })).rejects.toMatchObject({ code: "feedback.unauthorized" });
    await expect(authorization.createAccess({
      profileId: "signed", target, requestedOperations: ["feedback:read"], bearerToken: token({ unexpected: "claim" })
    })).rejects.toMatchObject({ code: "feedback.unauthorized" });
    await expect(authorization.createAccess({
      profileId: "signed", target, requestedOperations: ["feedback:read"], bearerToken: token({ jti: "x".repeat(201) })
    })).rejects.toMatchObject({ code: "feedback.unauthorized" });
  });

  it("resource束縛grantで上位discovery targetだけを許可し、束縛scopeを保持する", async () => {
    const authorization = runtime();
    for (const discoveryTarget of [
      { level: "profile", profileId: "signed" } as const,
      { level: "workspace", profileId: "signed", workspaceId: "OPS" } as const
    ]) {
      const access = await authorization.createAccess({
        profileId: "signed",
        target: discoveryTarget,
        requestedOperations: ["feedback:read"],
        bearerToken: token()
      });
      expect(access.grant).toMatchObject({ mode: "signed-grant", boundTarget: target });
      const decision = await authorization.ports.get("signed-grant")!.authorize({
        target: discoveryTarget,
        requestedOperations: ["feedback:read"],
        grant: access.grant
      });
      expect(decision.target).toEqual(discoveryTarget);
      expect(decision.allowedOperations).toContain("feedback:read");
    }

    await expect(authorization.createAccess({
      profileId: "signed",
      target: { level: "workspace", profileId: "signed", workspaceId: "OTHER" },
      requestedOperations: ["feedback:read"],
      bearerToken: token()
    })).rejects.toMatchObject({ code: "feedback.unauthorized" });
    await expect(authorization.createAccess({
      profileId: "signed",
      target: { level: "profile", profileId: "signed" },
      requestedOperations: ["feedback:create"],
      bearerToken: token()
    })).rejects.toMatchObject({ code: "feedback.unauthorized" });
    await expect(authorization.createAccess({
      profileId: "signed",
      target: { level: "profile", profileId: "signed" },
      requestedOperations: ["feedback:read"],
      bearerToken: token({ feedback_resource: { kind: "workspace", key: "OTHER" } })
    })).rejects.toMatchObject({ code: "feedback.unauthorized" });
  });

  it("unknown kidを一度だけrefreshし、別modeへfallbackしない", async () => {
    const request = vi.fn(async () => ({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ keys: [jwk] }) }));
    const authorization = runtime({ request });
    await expect(authorization.createAccess({
      profileId: "signed", target, requestedOperations: ["feedback:read"], bearerToken: token({}, "missing")
    })).rejects.toMatchObject({ code: "feedback.unauthorized" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("JWKS障害時にstale keyやpublic-profileを利用しない", async () => {
    const authorization = runtime({ async request() { throw new Error("network"); } });
    await expect(authorization.createAccess({
      profileId: "signed", target, requestedOperations: ["feedback:read"], bearerToken: token()
    })).rejects.toMatchObject({ code: "feedback.authorization_unavailable", status: 503 });
  });
});

describe("remote-authorization Mode", () => {
  const profile: FeedbackProviderProfileV2 = {
    ...baseProfile,
    profileId: "remote",
    authorization: { mode: "remote-authorization", authorizationProfileRef: "remote-api", subjectSource: "authenticated-adapter" }
  };
  const remoteTarget = { ...target, profileId: "remote" } as const;
  const remoteSettings: FeedbackServiceSettingsV2 = {
    ...settings,
    signedGrantIssuers: [],
    remoteAuthorizationProfiles: [{
      id: "remote-api",
      endpoint: "https://authorization.example/decision",
      timeoutMilliseconds: 2000,
      credentialRef: { kind: "server-secret", id: "REMOTE_CREDENTIAL" }
    }]
  };

  it("認証済みsubjectと対象をrequestごとに照合する", async () => {
    const request = vi.fn(async (input: { body?: string }) => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "1",
        target: remoteTarget,
        subject: { id: "opaque-host-subject", source: "authenticated-adapter" },
        allowedOperations: ["feedback:read"]
      })
    }));
    const authorization = createFeedbackAuthorizationRuntime({
      settings: remoteSettings,
      profileLoader: { async loadProfiles() { return [profile]; } },
      secretResolver: { async resolve(id) { expect(id).toBe("REMOTE_CREDENTIAL"); return "remote-secret"; } },
      httpClient: { request }
    });
    const access = await authorization.createAccess({
      profileId: "remote", target: remoteTarget, requestedOperations: ["feedback:read"], authenticatedSubjectId: "opaque-host-subject"
    });
    const decision = await authorization.ports.get("remote-authorization")!.authorize({
      target: remoteTarget,
      requestedOperations: ["feedback:read"],
      grant: access.grant
    });
    expect(decision.allowedOperations).toEqual(["feedback:read"]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("timeout／不正responseをfail-closedにし、retryしない", async () => {
    const request = vi.fn(async () => { throw new Error("timeout"); });
    const authorization = createFeedbackAuthorizationRuntime({
      settings: remoteSettings,
      profileLoader: { async loadProfiles() { return [profile]; } },
      secretResolver: { async resolve() { return "remote-secret"; } },
      httpClient: { request }
    });
    const access = await authorization.createAccess({
      profileId: "remote", target: remoteTarget, requestedOperations: ["feedback:read"], authenticatedSubjectId: "opaque-host-subject"
    });
    await expect(authorization.ports.get("remote-authorization")!.authorize({
      target: remoteTarget, requestedOperations: ["feedback:read"], grant: access.grant
    })).rejects.toMatchObject({ code: "feedback.authorization_unavailable" });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
