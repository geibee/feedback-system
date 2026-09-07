import { describe, expect, it } from "vitest";
import type { FeedbackProviderProfileV2 } from "@geibee/feedback-contracts/v2/server";
import { createThreadReferencePort, parseThreadReferenceKeyRing } from "./thread-reference.js";

const profile = {
  connectorKey: "test",
  secretRefs: { threadReferenceKeyRing: { kind: "server-secret", id: "REFERENCE_RING" } }
} as FeedbackProviderProfileV2;
const scope = { profileId: "profile", installationId: "installation", workspaceId: "workspace",
  resource: { kind: "record", key: "123" }, threadId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5001" };
const reference = { providerKey: "test", objectId: "private-ticket-42" };
const key = (kid: string, n: number) => ({ kid, key: Buffer.alloc(32, n).toString("base64url") });
const ring = (activeKid = "current", keys = [key("current", 7)]) => JSON.stringify({ activeKid, keys });

describe("暗号化thread参照", () => {
  it("再起動しても復号でき、random nonceで内部IDを秘匿する", async () => {
    const options = { audience: "service-origin-path", secretResolver: { async resolve() { return ring(); } } };
    const first = createThreadReferencePort(options);
    const token = (await first.seal(profile, scope, reference))!;
    expect(token).not.toContain(reference.objectId);
    expect(await first.seal(profile, scope, reference)).not.toBe(token);
    expect(await createThreadReferencePort(options).open(profile, scope, token)).toEqual(reference);
  });
  it("改変・scope/audience/provider変更・期限切れ・未知kidをfail-closedにする", async () => {
    let time = 0;
    let source = ring();
    const options = { audience: "a", now: () => time, secretResolver: { async resolve() { return source; } } };
    const port = createThreadReferencePort(options);
    const token = (await port.seal(profile, scope, reference))!;
    for (const changed of [
      { ...scope, profileId: "other" }, { ...scope, installationId: "other" },
      { ...scope, workspaceId: "other" }, { ...scope, resource: { kind: "other", key: "123" } },
      { ...scope, resource: { kind: "record", key: "456" } }, { ...scope, threadId: "other" }
    ]) await expect(port.open(profile, changed, token)).rejects.toMatchObject({ code: "feedback.integrity_error", retryable: false });
    await expect(createThreadReferencePort({ ...options, audience: "b" }).open(profile, scope, token)).rejects.toThrow();
    await expect(port.open({ ...profile, connectorKey: "other" }, scope, token)).rejects.toThrow();
    await expect(port.open(profile, scope, token.replace(/\.[^.]+$/u, ".AAAA"))).rejects.toThrow();
    await expect(port.open(profile, scope, token + "=")).rejects.toThrow();
    source = ring("next", [key("next", 8), key("current", 7)]);
    expect(await port.open(profile, scope, token)).toEqual(reference);
    source = ring("next", [key("next", 8)]);
    await expect(port.open(profile, scope, token)).rejects.toThrow();
    source = ring();
    time = 30 * 24 * 60 * 60 * 1000;
    await expect(port.open(profile, scope, token)).rejects.toThrow();
  });
  it("専用鍵なしでは発行しない。鍵長・active数・重複・余剰fieldを拒否する", async () => {
    const port = createThreadReferencePort({ audience: "a", secretResolver: { async resolve() { throw new Error(); } } });
    expect(await port.seal({ ...profile, secretRefs: {} } as FeedbackProviderProfileV2, scope, reference)).toBeUndefined();
    for (const source of ["null", "{}", ring("missing"), ring("current", []),
      ring("current", [key("current", 7), key("current", 8)]),
      ring("current", [{ kid: "current", key: Buffer.alloc(31).toString("base64url") }]),
      JSON.stringify({ activeKid: "current", keys: [key("current", 7)], extra: true })]) {
      expect(() => parseThreadReferenceKeyRing(source)).toThrow();
    }
  });
});
