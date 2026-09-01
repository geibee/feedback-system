import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  calculateFeedbackCommandHash,
  canonicalizeFeedbackJson,
  createFeedbackEnvelopeCodec,
  deriveFeedbackParticipantId,
  feedbackAttachmentMarkerDomainSeparator,
  feedbackCommandDomainSeparator,
  feedbackEnvelopeDomainSeparator,
  feedbackMessageMarkerDomainSeparator,
  feedbackParticipantCredentialDomainSeparator,
  feedbackParticipantIdDomainSeparator
} from "./index.js";

const key = Uint8Array.from({ length: 32 }, (_, index) => index);
const context = {
  profileId: "inventory-production",
  installationId: "ari:cloud:jira::site/11111111-2222-4333-8444-555555555555",
  objectId: "10042"
};

function vectors() {
  return JSON.parse(readFileSync(new URL("../../../docs/phase0/envelope-test-vectors.json", import.meta.url), "utf8")) as {
    testOnlyKey: { kid: string; value: string };
    vectors: Array<{ purpose: string; canonicalPayload: string; payload: Record<string, unknown>; signature: string }>;
  };
}

describe("Envelope codec", () => {
  it("用途ごとにdomain separatorを分離する", () => {
    const values = [
      feedbackEnvelopeDomainSeparator,
      feedbackMessageMarkerDomainSeparator,
      feedbackAttachmentMarkerDomainSeparator,
      feedbackParticipantCredentialDomainSeparator,
      feedbackParticipantIdDomainSeparator,
      feedbackCommandDomainSeparator
    ];
    expect(new Set(values).size).toBe(values.length);
  });

  it("ADR vectorどおりにcanonicalize、署名、検証する", async () => {
    const fixture = vectors();
    const codec = createFeedbackEnvelopeCodec([{ kid: fixture.testOnlyKey.kid, secret: key, state: "active" }]);
    const envelopeVector = fixture.vectors.find((value) => value.purpose === "envelope")!;
    expect(canonicalizeFeedbackJson(envelopeVector.payload)).toBe(envelopeVector.canonicalPayload);
    const envelope = await codec.signEnvelope(envelopeVector.payload as never);
    expect(envelope.signature.value).toBe(envelopeVector.signature);
    expect(await codec.verifyEnvelope(envelope, context)).toMatchObject({ valid: true });

    const markerVector = fixture.vectors.find((value) => value.purpose === "message-marker")!;
    expect(canonicalizeFeedbackJson(markerVector.payload)).toBe(markerVector.canonicalPayload);
    const marker = await codec.signMessageMarker(markerVector.payload as never);
    expect(marker.signature.value).toBe(markerVector.signature);
    expect(await codec.verifyMessageMarker(marker, context)).toMatchObject({ valid: true });
  });

  it("改ざん、別objectへのreplay、unknown kidをfail-closedにする", async () => {
    const fixture = vectors();
    const codec = createFeedbackEnvelopeCodec([{ kid: fixture.testOnlyKey.kid, secret: key, state: "active" }]);
    const payload = fixture.vectors.find((value) => value.purpose === "envelope")!.payload;
    const envelope = await codec.signEnvelope(payload as never);
    expect(await codec.verifyEnvelope({ ...envelope, requestHash: `sha256:${"0".repeat(64)}` }, context))
      .toEqual({ valid: false, reason: "signature" });
    expect(await codec.verifyEnvelope(envelope, { ...context, objectId: "10043" }))
      .toEqual({ valid: false, reason: "binding" });
    expect(await codec.verifyEnvelope({ ...envelope, signature: { ...envelope.signature, kid: "unknown" } }, context))
      .toEqual({ valid: false, reason: "unknown_kid" });
  });

  it("active keyを一つに固定し、旧keyは検証専用にできる", async () => {
    const fixture = vectors();
    const oldCodec = createFeedbackEnvelopeCodec([{ kid: "old", secret: key, state: "active" }]);
    const signedWithOld = await oldCodec.signEnvelope(fixture.vectors.find((value) => value.purpose === "envelope")!.payload as never);
    const nextKey = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
    const rotated = createFeedbackEnvelopeCodec([
      { kid: "current", secret: nextKey, state: "active" },
      { kid: "old", secret: key, state: "verify-only" }
    ]);
    expect(await rotated.verifyEnvelope(signedWithOld, context)).toMatchObject({ valid: true });
    expect((await rotated.signEnvelope(fixture.vectors.find((value) => value.purpose === "envelope")!.payload as never)).signature.kid)
      .toBe("current");
    expect(() => createFeedbackEnvelopeCodec([
      { kid: "a", secret: key, state: "active" },
      { kid: "b", secret: nextKey, state: "active" }
    ])).toThrow(/一つだけ/);
  });

  it("attachment mappingを署名し、binaryのhashとprovider bindingを保護する", async () => {
    const codec = createFeedbackEnvelopeCodec([{ kid: "attachment", secret: key, state: "active" }]);
    const marker = await codec.signAttachmentMarker({
      schemaVersion: "2",
      threadId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5001",
      messageId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5010",
      attachmentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5030",
      intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5031",
      requestHash: `sha256:${"1".repeat(64)}`,
      providerBinding: context,
      providerAttachmentId: "20001",
      filename: "phase2.txt",
      contentType: "text/plain",
      sizeBytes: 12,
      contentHash: `sha256:${"2".repeat(64)}`,
      createdAt: "2026-08-31T06:02:00.000Z"
    });
    expect(await codec.verifyAttachmentMarker(marker, context)).toMatchObject({ valid: true });
    expect(await codec.verifyAttachmentMarker({ ...marker, providerAttachmentId: "20002" }, context))
      .toEqual({ valid: false, reason: "signature" });
    expect(await codec.verifyAttachmentMarker({ ...marker, messageId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5011" }, context))
      .toEqual({ valid: false, reason: "signature" });
  });

  it("command hashをkey順に依存しないdomain-separated hashへ固定する", () => {
    expect(calculateFeedbackCommandHash({ b: 2, a: "x" })).toBe(calculateFeedbackCommandHash({ a: "x", b: 2 }));
    expect(calculateFeedbackCommandHash({ a: "x", b: 2 })).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(() => canonicalizeFeedbackJson({ bad: Number.NaN })).toThrow(/finite/);
    expect(() => canonicalizeFeedbackJson({ bad: "\ud800" })).toThrow(/surrogate/);
    expect(() => canonicalizeFeedbackJson(new Array(2))).toThrow(/array/);
  });

  it("schema外のscopeやunknown fieldを署名前に拒否する", async () => {
    const fixture = vectors();
    const codec = createFeedbackEnvelopeCodec([{ kid: "strict", secret: key, state: "active" }]);
    const payload = fixture.vectors.find((value) => value.purpose === "envelope")!.payload;
    await expect(codec.signEnvelope({
      ...payload,
      scope: { ...(payload.scope as object), providerProjectId: "10000" }
    } as never)).rejects.toThrow(/schema/);
  });

  it("credential署名key rotationと独立してparticipant IDを安定導出する", () => {
    const input = {
      profileId: "inventory-production",
      origin: "https://inventory.example.invalid",
      browserProfileId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5020"
    };
    const first = deriveFeedbackParticipantId(key, input);
    expect(deriveFeedbackParticipantId(key, input)).toBe(first);
    expect(first).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
    expect(deriveFeedbackParticipantId(Uint8Array.from({ length: 32 }, () => 7), input)).not.toBe(first);
  });
});
