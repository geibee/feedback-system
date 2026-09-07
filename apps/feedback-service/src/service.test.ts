import type { FeedbackProviderProfileV2, FeedbackServiceSettingsV2 } from "@geibee/feedback-contracts/v2/server";
import { createFakeFeedbackRepository } from "@geibee/feedback-connector-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import type { FeedbackReadOnlyConfiguration } from "./configuration.js";
import { createFeedbackService, type FeedbackProviderCredentialValidatorPort } from "./service.js";

const key1 = Buffer.alloc(32, 1).toString("base64url");
const key2 = Buffer.alloc(32, 2).toString("base64url");
const derivationKey = Buffer.alloc(32, 3).toString("base64url");
const validRing = JSON.stringify({
  activeKid: "current",
  keys: [
    { kid: "current", key: key1 },
    { kid: "previous", key: key2 }
  ]
});
const jiraCredential = JSON.stringify({
  kind: "jira-cloud-basic",
  email: "feedback@example.com",
  apiToken: "jira-token"
});
const redmineCredential = JSON.stringify({ kind: "redmine-api-key", apiKey: "redmine-key" });

const settings: FeedbackServiceSettingsV2 = {
  schemaVersion: "2",
  serviceId: "readiness-test",
  profileFiles: ["/profile.json"],
  signedGrantIssuers: [],
  remoteAuthorizationProfiles: [],
  jwksCache: { maximumIssuers: 1, maximumKeysPerIssuer: 1, maximumTtlSeconds: 1 }
};

function profile(connectorKey: string): FeedbackProviderProfileV2 {
  return {
    schemaVersion: "2",
    profileId: "production",
    displayName: "Production",
    connectorKey,
    installationId: "installation",
    workspacePolicy: {
      workspaceIds: ["OPS"],
      workspaceDiscovery: "supported",
      resourceDiscovery: "supported"
    },
    authorization: { mode: "public-profile" },
    policy: { operations: ["feedback:read"], resourceKinds: ["record"] },
    capabilities: {
      operations: ["feedback:read"],
      discovery: { workspaces: "supported", resources: "supported" },
      operationGuarantees: {
        create: "unsupported",
        reply: "unsupported",
        revision: "unsupported",
        attachmentUpload: "unsupported"
      },
      creationFields: [],
      maximumMetadataBytes: 32768,
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
}

function fixture(input: {
  connectorKey?: string;
  referenceKeyRing?: string;
  secrets?: Readonly<Record<string, string>>;
  providerCredentialValidator?: FeedbackProviderCredentialValidatorPort;
} = {}) {
  const connectorKey = input.connectorKey ?? "jira-cloud";
  const currentProfile = profile(connectorKey);
  if (input.referenceKeyRing !== undefined) currentProfile.secretRefs.threadReferenceKeyRing = { kind: "server-secret", id: "REFERENCE_RING" };
  const secrets = input.secrets ?? {
    PROVIDER: connectorKey === "redmine" ? redmineCredential : jiraCredential,
    ENVELOPE_RING: validRing,
    PARTICIPANT_RING: validRing,
    DERIVATION_KEY: derivationKey,
    ...(input.referenceKeyRing === undefined ? {} : { REFERENCE_RING: input.referenceKeyRing })
  };
  const configuration: FeedbackReadOnlyConfiguration = {
    settings,
    profileLoader: { async loadProfiles() { return [currentProfile]; } },
    secretResolver: {
      async resolve(id) {
        const secret = secrets[id];
        if (secret === undefined) throw new Error(`missing secret: ${id}`);
        return secret;
      }
    }
  };
  return createFeedbackService({
    configuration,
    connectors: new Map([[connectorKey, createFakeFeedbackRepository()]]),
    projectionVerifier: { async verify() { return { valid: false, reason: "signature" }; } },
    expectedOrigin: "https://app.example",
    maximumRequestBytes: 4096,
    operationTimeoutMilliseconds: 1000,
    httpClient: { async request() { throw new Error("unexpected HTTP"); } },
    ...(input.providerCredentialValidator ? {
      providerCredentialValidator: input.providerCredentialValidator
    } : {})
  });
}

describe("Feedback Service readiness", () => {
  it("任意の参照鍵を設定した場合もring形式・鍵長をreadinessで検査する", async () => {
    await expect(fixture({ referenceKeyRing: validRing }).readiness()).resolves.toMatchObject({ ready: true });
    for (const source of ["{}", "bad", JSON.stringify({ activeKid: "current", keys: [{ kid: "current", key: "short" }] })]) {
      await expect(fixture({ referenceKeyRing: source }).readiness()).resolves.toMatchObject({ ready: false });
    }
  });

  it("Jira Cloud credential、active一鍵、verify-only鍵、分離導出鍵を検証してreadyにする", async () => {
    await expect(fixture().readiness()).resolves.toEqual({ ready: true, profileCount: 1 });
  });

  it("Redmine credentialのexact JSONを検証してreadyにする", async () => {
    await expect(fixture({ connectorKey: "redmine" }).readiness())
      .resolves.toEqual({ ready: true, profileCount: 1 });

    await expect(fixture({
      connectorKey: "redmine",
      secrets: {
        PROVIDER: JSON.stringify({ kind: "redmine-api-key", apiToken: "wrong-field" }),
        ENVELOPE_RING: validRing,
        PARTICIPANT_RING: validRing,
        DERIVATION_KEY: derivationKey
      }
    }).readiness()).resolves.toEqual({ ready: false, profileCount: 1 });
  });

  it.each([
    ["JSONでないring", "not-json"],
    ["active鍵がないring", JSON.stringify({ activeKid: "missing", keys: [{ kid: "current", key: key1 }] })],
    ["kidが重複したring", JSON.stringify({
      activeKid: "current",
      keys: [{ kid: "current", key: key1 }, { kid: "current", key: key2 }]
    })],
    ["短い鍵のring", JSON.stringify({
      activeKid: "current",
      keys: [{ kid: "current", key: Buffer.alloc(31, 1).toString("base64url") }]
    })],
    ["明示stateを混入したring", JSON.stringify({
      activeKid: "current",
      keys: [{ kid: "current", key: key1, state: "active" }]
    })]
  ])("%sをready:falseにする", async (_name, envelopeRing) => {
    await expect(fixture({
      secrets: {
        PROVIDER: jiraCredential,
        ENVELOPE_RING: envelopeRing,
        PARTICIPANT_RING: validRing,
        DERIVATION_KEY: derivationKey
      }
    }).readiness()).resolves.toEqual({ ready: false, profileCount: 1 });
  });

  it("participant credential ringと導出鍵も形式を検証する", async () => {
    await expect(fixture({
      secrets: {
        PROVIDER: jiraCredential,
        ENVELOPE_RING: validRing,
        PARTICIPANT_RING: JSON.stringify({ activeKid: "missing", keys: [{ kid: "old", key: key1 }] }),
        DERIVATION_KEY: derivationKey
      }
    }).readiness()).resolves.toEqual({ ready: false, profileCount: 1 });

    await expect(fixture({
      secrets: {
        PROVIDER: jiraCredential,
        ENVELOPE_RING: validRing,
        PARTICIPANT_RING: validRing,
        DERIVATION_KEY: Buffer.alloc(31, 3).toString("base64url")
      }
    }).readiness()).resolves.toEqual({ ready: false, profileCount: 1 });
  });

  it.each([
    ["malformed JSON", "{"],
    ["Jira kind違い", JSON.stringify({ kind: "redmine-api-key", email: "feedback@example.com", apiToken: "token" })],
    ["Jira field過剰", JSON.stringify({ kind: "jira-cloud-basic", email: "feedback@example.com", apiToken: "token", extra: true })],
    ["Redmine形式をJiraへ流用", redmineCredential]
  ])("不正provider credential (%s)をready:falseにする", async (_name, providerCredential) => {
    await expect(fixture({
      secrets: {
        PROVIDER: providerCredential,
        ENVELOPE_RING: validRing,
        PARTICIPANT_RING: validRing,
        DERIVATION_KEY: derivationKey
      }
    }).readiness()).resolves.toEqual({ ready: false, profileCount: 1 });
  });

  it("必須secret不足をthrowで漏らさずready:falseにする", async () => {
    await expect(fixture({
      secrets: {
        PROVIDER: jiraCredential,
        ENVELOPE_RING: validRing,
        PARTICIPANT_RING: validRing
      }
    }).readiness()).resolves.toEqual({ ready: false, profileCount: 1 });
  });

  it("未知Connectorはvalidatorなしでfail-closed、明示validatorが成功した場合だけreadyにする", async () => {
    const secrets = {
      PROVIDER: "custom-secret",
      ENVELOPE_RING: validRing,
      PARTICIPANT_RING: validRing,
      DERIVATION_KEY: derivationKey
    };
    await expect(fixture({ connectorKey: "custom", secrets }).readiness())
      .resolves.toEqual({ ready: false, profileCount: 1 });

    const validate = vi.fn<(input: { profile: FeedbackProviderProfileV2; secret: string }) => void>();
    await expect(fixture({
      connectorKey: "custom",
      secrets,
      providerCredentialValidator: { validate }
    }).readiness()).resolves.toEqual({ ready: true, profileCount: 1 });
    expect(validate).toHaveBeenCalledWith({ profile: profile("custom"), secret: "custom-secret" });
  });

  it("未知Connectorのvalidator failureをready:falseにする", async () => {
    await expect(fixture({
      connectorKey: "custom",
      secrets: {
        PROVIDER: "invalid-custom-secret",
        ENVELOPE_RING: validRing,
        PARTICIPANT_RING: validRing,
        DERIVATION_KEY: derivationKey
      },
      providerCredentialValidator: { validate() { throw new Error("invalid custom credential"); } }
    }).readiness()).resolves.toEqual({ ready: false, profileCount: 1 });
  });
});
