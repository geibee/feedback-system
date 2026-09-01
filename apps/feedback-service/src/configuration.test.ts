import { describe, expect, it } from "vitest";
import {
  createEnvironmentSecretResolver,
  loadFeedbackReadOnlyConfiguration
} from "./configuration.js";

const settings = {
  schemaVersion: "2",
  serviceId: "feedback-test",
  profileFiles: ["/profiles/public.json"],
  signedGrantIssuers: [],
  remoteAuthorizationProfiles: [],
  jwksCache: { maximumIssuers: 2, maximumKeysPerIssuer: 4, maximumTtlSeconds: 60 }
};

const profile = {
  schemaVersion: "2",
  profileId: "public",
  displayName: "Public",
  connectorKey: "fake",
  installationId: "fake-1",
  workspacePolicy: { workspaceIds: ["OPS"], workspaceDiscovery: "supported", resourceDiscovery: "supported" },
  authorization: { mode: "public-profile" },
  policy: { operations: ["feedback:read"], resourceKinds: ["record"] },
  capabilities: {
    operations: ["feedback:read"],
    discovery: { workspaces: "supported", resources: "supported" },
    operationGuarantees: { create: "unsupported", reply: "unsupported", revision: "unsupported", attachmentUpload: "unsupported" },
    creationFields: [],
    maximumMetadataBytes: 32768,
    projectionValidation: "envelope-required",
    uniqueThreadLookup: true
  },
  secretRefs: {
    providerCredential: { kind: "server-secret", id: "PROVIDER_SECRET" },
    envelopeKeyRing: { kind: "server-secret", id: "ENVELOPE_RING" },
    participantCredentialKeyRing: { kind: "server-secret", id: "PARTICIPANT_RING" },
    participantIdDerivationKey: { kind: "server-secret", id: "PARTICIPANT_DERIVATION" }
  }
};

describe("read-only Feedback Service configuration", () => {
  it("settingsとprofileを一度だけ読んだimmutable snapshotにする", async () => {
    const reads: string[] = [];
    const configuration = await loadFeedbackReadOnlyConfiguration({
      settingsFile: "/settings.json",
      environment: { PROVIDER_SECRET: "secret" },
      async readTextFile(path) {
        reads.push(path);
        return JSON.stringify(path === "/settings.json" ? settings : profile);
      }
    });
    const first = await configuration.profileLoader.loadProfiles();
    const second = await configuration.profileLoader.loadProfiles();
    expect(reads).toEqual(["/settings.json", "/profiles/public.json"]);
    expect(second).toBe(first);
    expect(Object.isFrozen(first[0]?.authorization)).toBe(true);
  });

  it("unknown fieldとmode参照不足を起動時に拒否する", async () => {
    await expect(loadFeedbackReadOnlyConfiguration({
      settingsFile: "/settings.json",
      environment: {},
      async readTextFile(path) {
        return JSON.stringify(path === "/settings.json"
          ? settings
          : { ...profile, authorization: { mode: "signed-grant", issuerProfileRef: "missing" } });
      }
    })).rejects.toThrow(/issuer profileがありません/);
    await expect(loadFeedbackReadOnlyConfiguration({
      settingsFile: "/settings.json",
      environment: {},
      async readTextFile(path) {
        return JSON.stringify(path === "/settings.json" ? settings : { ...profile, credential: "leak" });
      }
    })).rejects.toThrow(/unknown field/);
  });

  it("secretに既定値を持たず、参照名以外を受け付けない", async () => {
    const resolver = createEnvironmentSecretResolver({ PRESENT: "value" });
    await expect(resolver.resolve("MISSING")).rejects.toThrow("必須secret");
    await expect(resolver.resolve("bad-name")).rejects.toThrow("reference ID");
    await expect(resolver.resolve("PRESENT")).resolves.toBe("value");
  });
});
