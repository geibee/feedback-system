import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
}

function v2Validator(name: string) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(readJson(`../schemas/${name}.schema.json`) as AnySchema);
}

describe("Feedback v2 schema契約", () => {
  it("Phase 0 Envelope vectorを署名付きv2 Envelopeとして検証する", () => {
    const vectors = readJson("../../../docs/phase0/envelope-test-vectors.json") as {
      vectors: Array<{ purpose: string; payload: Record<string, unknown>; signature: string }>;
      testOnlyKey: { kid: string };
    };
    const envelopeVector = vectors.vectors.find((value) => value.purpose === "envelope");
    if (!envelopeVector) throw new Error("Envelope vectorがありません");
    const validate = v2Validator("feedback-envelope");
    const envelope: Record<string, unknown> = {
      ...envelopeVector.payload,
      signature: { alg: "HS256", kid: vectors.testOnlyKey.kid, value: envelopeVector.signature }
    };
    expect(validate(envelope), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...envelope, providerBinding: { ...(envelope.providerBinding as object), issueId: "10042" } })).toBe(false);
  });

  it("message markerを親provider bindingへ束縛する", () => {
    const vectors = readJson("../../../docs/phase0/envelope-test-vectors.json") as {
      vectors: Array<{ purpose: string; payload: Record<string, unknown>; signature: string }>;
      testOnlyKey: { kid: string };
    };
    const markerVector = vectors.vectors.find((value) => value.purpose === "message-marker");
    if (!markerVector) throw new Error("message marker vectorがありません");
    const validate = v2Validator("feedback-message-marker");
    expect(validate({
      ...markerVector.payload,
      signature: { alg: "HS256", kid: vectors.testOnlyKey.kid, value: markerVector.signature }
    }), JSON.stringify(validate.errors)).toBe(true);
  });

  it("attachment markerをthread内messageへ署名付きで束縛する", () => {
    const validate = v2Validator("feedback-attachment-marker");
    const marker = {
      schemaVersion: "2",
      threadId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5001",
      messageId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5010",
      attachmentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5030",
      intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5031",
      requestHash: `sha256:${"1".repeat(64)}`,
      providerBinding: { profileId: "inventory", installationId: "site", objectId: "10001" },
      providerAttachmentId: "30001",
      filename: "evidence.txt",
      contentType: "text/plain",
      sizeBytes: 3,
      contentHash: `sha256:${"2".repeat(64)}`,
      createdAt: "2026-09-01T00:00:00.000Z",
      signature: { alg: "HS256", kid: "current", value: "x".repeat(43) }
    };
    expect(validate(marker), JSON.stringify(validate.errors)).toBe(true);
    const { messageId: _messageId, ...unbound } = marker;
    expect(validate(unbound)).toBe(false);
  });

  it("provider profileを単一modeとserver-side secret referenceへ固定する", () => {
    const validate = v2Validator("feedback-provider-profile");
    const profile = readJson("../fixtures/v2/provider-profile-signed-grant.json") as Record<string, unknown>;
    expect(validate(profile), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...profile, authorizationModeFallback: "public-profile" })).toBe(false);
    expect(validate({
      ...profile,
      authorization: { mode: "signed-grant", issuerProfileRef: "inventory-issuer", fallbackMode: "public-profile" }
    })).toBe(false);
    expect(validate({ ...profile, apiToken: "plain-text-secret" })).toBe(false);
  });

  it("service settingsを非secret read-only profile file設定へ限定する", () => {
    const validate = v2Validator("feedback-service-settings");
    const settings = readJson("../fixtures/v2/service-settings.json") as Record<string, unknown>;
    expect(validate(settings), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...settings, databaseUrl: "postgres://example.invalid/feedback" })).toBe(false);
    expect(validate({ ...settings, profileFiles: ["relative/profile.json"] })).toBe(false);
  });

  it("projectionはstrictな候補抽出fieldだけを受ける", () => {
    const validate = v2Validator("feedback-projection");
    const projection = {
      schemaVersion: "2",
      threadId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5001",
      intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5002",
      requestHash: "sha256:4f2f65f5a90ec7be0abfcae5324f96b5b9574cf43a5f4d31d436098038077e7d",
      profileId: "inventory-production",
      workspaceId: "OPS",
      resource: { kind: "record", key: "order-001" }
    };
    expect(validate(projection), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...projection, trusted: true })).toBe(false);
  });

  it("signed grantのaudienceを単一string、grant kind別claimを必須にする", () => {
    const validate = v2Validator("feedback-authorization");
    const claims = {
      iss: "https://issuer.example.invalid/",
      sub: "user-123",
      aud: "urn:geibee:feedback-service:feedback-production",
      iat: 2000000000,
      exp: 2000000300,
      scope: "feedback:read feedback:create",
      feedback_grant_kind: "oidc",
      feedback_profile_id: "inventory-production",
      feedback_workspace_id: "OPS",
      feedback_resource: { kind: "record", key: "order-001" },
      azp: "feedback-browser"
    };
    expect(validate(claims), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...claims, aud: [claims.aud] })).toBe(false);
    const { azp: _azp, ...withoutAzp } = claims;
    expect(validate(withoutAzp)).toBe(false);
    expect(validate({
      ...withoutAzp,
      feedback_grant_kind: "token-exchange",
      client_id: "feedback-exchange",
      act: { sub: "trusted-actor" }
    }), JSON.stringify(validate.errors)).toBe(true);
  });

  it("remote authorization decisionをrequestと同じ対象へ束縛するstrict DTOにする", () => {
    const validate = v2Validator("feedback-authorization");
    const request = {
      schemaVersion: "1",
      target: {
        level: "resource",
        profileId: "inventory-production",
        workspaceId: "OPS",
        resource: { kind: "record", key: "order-001" }
      },
      requestedOperations: ["feedback:read"],
      subject: { id: "subject-opaque", source: "authenticated-adapter" }
    };
    const decision = {
      schemaVersion: "1",
      target: {
        level: "resource",
        profileId: "inventory-production",
        workspaceId: "OPS",
        resource: { kind: "record", key: "order-001" }
      },
      subject: { id: "subject-opaque", source: "authenticated-adapter" },
      allowedOperations: ["feedback:read"]
    };
    expect(validate(request), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(decision), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...decision, fallbackMode: "public-profile" })).toBe(false);
  });
});

describe("Feedback v2 stable orderingと回復fixture", () => {
  it("同一timestampをeventIdで安定化しattachmentだけではunreadにしない", () => {
    const fixture = readJson("../fixtures/v2/stable-ordering-unread.json") as {
      lastViewed: { occurredAt: string; eventId: string };
      events: Array<{ occurredAt: string; eventId: string; kind: string }>;
      expectedEventIds: string[];
      expectedUnreadEventIds: string[];
    };
    const ordering = (value: { occurredAt: string; eventId: string }) => `${value.occurredAt}\u0000${value.eventId}`;
    const ordered = [...fixture.events].sort((left, right) => ordering(left).localeCompare(ordering(right)));
    const unread = ordered.filter((event) =>
      ordering(event) > ordering(fixture.lastViewed) &&
      ["initial-message", "reply", "revision"].includes(event.kind)
    );
    expect(ordered.map((event) => event.eventId)).toEqual(fixture.expectedEventIds);
    expect(unread.map((event) => event.eventId)).toEqual(fixture.expectedUnreadEventIds);
  });

  it("requestHash vectorをdomain-separated SHA-256へ固定する", () => {
    const vector = readJson("../fixtures/v2/request-hash-vector.json") as {
      domainSeparator: string;
      canonicalInput: string;
      requestHash: string;
    };
    const actual = `sha256:${createHash("sha256").update(vector.domainSeparator + vector.canonicalInput, "utf8").digest("hex")}`;
    expect(actual).toBe(vector.requestHash);
  });

  it("upload、projection、recovery negative fixtureが自動writeを許可しない", () => {
    const attachment = readJson("../fixtures/v2/attachment-permission-negative.json") as {
      cases: Array<{ expected: { outcome: string; repositoryCalls?: number; maximumUploadAttempts?: number } }>;
    };
    expect(attachment.cases.filter((value) => value.expected.outcome === "deny")
      .every((value) => value.expected.repositoryCalls === 0)).toBe(true);

    const projection = readJson("../fixtures/v2/projection-validation-negative.json") as {
      cases: Array<{ expected: { serializeCandidate: boolean; legacyFallback?: boolean } }>;
    };
    expect(projection.cases.every((value) => value.expected.serializeCandidate === false)).toBe(true);
    expect(projection.cases.filter((value) => "legacyFallback" in value.expected)
      .every((value) => value.expected.legacyFallback === false)).toBe(true);

    const recovery = readJson("../fixtures/v2/operation-recovery-negative.json") as {
      cases: Array<{ expected: { automaticWriteCalls: number; maximumUploadAttempts?: number } }>;
    };
    expect(recovery.cases.every((value) => value.expected.automaticWriteCalls === 0)).toBe(true);
    expect(recovery.cases.find((value) => value.expected.maximumUploadAttempts !== undefined)?.expected.maximumUploadAttempts).toBe(1);
  });
});
