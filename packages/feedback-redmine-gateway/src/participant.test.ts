import { describe, expect, it } from "vitest";
import {
  issueParticipantCredential,
  requireParticipantCredential,
  signMessageMarker
} from "./participant.js";

const signingKey = "participant-test-signing-key-32-bytes-minimum";
const browserProfileId = "00000000-0000-4000-8000-000000000007";
const participantId = "00000000-0000-5000-8000-000000000008";

describe("participant credential", () => {
  it("非公開browser profile IDから公開participant IDを導出しorigin/profile scope付きで署名する", async () => {
    const issued = await issueParticipantCredential({
      browserProfileId,
      profileId: "inventory-production",
      origin: "https://app.example",
      signingKey
    });
    expect(issued.participantId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(issued.participantId).not.toBe(browserProfileId);
    expect((await issueParticipantCredential({
      browserProfileId,
      profileId: "inventory-production",
      origin: "https://app.example",
      signingKey
    })).participantId).toBe(issued.participantId);
    const principal = await requireParticipantCredential({
      request: request(issued.credential),
      profileId: "inventory-production",
      signingKey
    });
    expect(principal).toMatchObject({ participantId: issued.participantId, browserProfileId, origin: "https://app.example" });

    const replay = await issueParticipantCredential({
      browserProfileId: participantId,
      profileId: "inventory-production",
      origin: "https://app.example",
      signingKey
    });
    expect(replay.participantId).not.toBe(issued.participantId);
  });

  it("改ざん、別origin、別profileを拒否する", async () => {
    const issued = await issueParticipantCredential({
      browserProfileId,
      profileId: "inventory-production",
      origin: "https://app.example",
      signingKey
    });
    await expect(requireParticipantCredential({
      request: request(`${issued.credential.slice(0, -1)}x`),
      profileId: "inventory-production",
      signingKey
    })).rejects.toMatchObject({ status: 403 });
    await expect(requireParticipantCredential({
      request: request(issued.credential, "https://other.example"),
      profileId: "inventory-production",
      signingKey
    })).rejects.toMatchObject({ status: 403 });
    await expect(requireParticipantCredential({
      request: request(issued.credential),
      profileId: "other-profile",
      signingKey
    })).rejects.toMatchObject({ status: 403 });
  });

  it("message marker署名をmessage/version/bodyへ束縛する", async () => {
    const base = {
      signingKey,
      profileId: "inventory-production",
      threadId: "00000000-0000-4000-8000-000000000001",
      messageId: "00000000-0000-4000-8000-000000000008",
      participantId,
      kind: "reply" as const,
      version: 1,
      intentId: "00000000-0000-4000-8000-000000000009",
      body: "返信"
    };
    const signature = await signMessageMarker(base);
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(await signMessageMarker({ ...base, version: 2 })).not.toBe(signature);
    expect(await signMessageMarker({ ...base, body: "改ざん" })).not.toBe(signature);
  });
});

function request(credential: string, origin = "https://app.example"): Request {
  return new Request(`${origin}/internal/feedback-redmine/v1/profiles/inventory-production/me`, {
    headers: { "X-Feedback-Participant-Credential": credential }
  });
}
