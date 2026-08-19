import { describe, expect, it, vi } from "vitest";
import type { RedmineFetch } from "@feedback/redmine-core/trusted";
import { fakeStorage } from "../fake-storage.test-helper.js";
import { extensionProfiles } from "../test-fixtures.js";
import { ExtensionProfileRepository } from "../storage/chrome-storage.js";
import { CredentialVault } from "./credential-vault.js";
import { EvidenceStaging } from "./evidence-staging.js";
import { ExtensionMessageHandler } from "./message-handler.js";

const optionsSender = { id: "extension-id", url: "chrome-extension://extension-id/options.html" };
const contentSender = { id: "extension-id", tab: { url: "https://inventory.example.invalid/orders/1" } };

describe("extension sender・credential security", () => {
  it("unlock前にcurrent userを検証しAPI keyをsessionだけへ保存する", async () => {
    const storage = fakeStorage({ local: { "feedback.redmine.v1.profiles": extensionProfiles } });
    const fetch = vi.fn<RedmineFetch>(async (url, init) => {
      expect(init.headers).toMatchObject({ "X-Redmine-API-Key": "transient-test-key" });
      expect(init.redirect).toBe("error");
      const path = new URL(url).pathname;
      if (path.endsWith("/users/current.json")) {
        return json({ user: { id: 7, login: "user", firstname: "利用", lastname: "者", api_key: "discard" } });
      }
      if (path.endsWith("/projects/12.json")) return json({ project: { id: 12, name: "Feedback" } });
      if (path.endsWith("/issues.json")) return json({ issues: [], total_count: 0, offset: 0, limit: 1 });
      throw new Error(`unexpected request: ${url}`);
    });
    const handler = createHandler(storage, fetch);
    const response = await handler.handle(request("profile.unlock.v1", {
      profileId: "inventory-production", apiKey: "transient-test-key"
    }), optionsSender);
    expect(response.ok).toBe(true);
    expect(JSON.stringify(storage.session.data)).toContain("transient-test-key");
    expect(JSON.stringify(storage.local.data)).not.toContain("transient-test-key");
    expect(JSON.stringify(response)).not.toContain("transient-test-key");
    expect(JSON.stringify(response)).not.toContain("api_key");
    const diagnostic = await handler.handle(request("diagnostic.download.v1", {
      profileId: "inventory-production"
    }), optionsSender);
    expect(diagnostic).toMatchObject({
      ok: true,
      result: {
        schemaVersion: "1",
        entries: [{
          operation: "profile.unlock.v1",
          profileId: "inventory-production",
          httpStatus: 200,
          errorCode: null
        }]
      }
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/transient-test-key|body|filename|threadId|principal/u);
  });

  it("sender ID/origin不一致と任意URL propertyをRedmine fetch前に拒否する", async () => {
    const storage = fakeStorage({ local: { "feedback.redmine.v1.profiles": extensionProfiles } });
    const fetch = vi.fn<RedmineFetch>();
    const handler = createHandler(storage, fetch);
    const message = request("redmine.profile.get.v1", { profileId: "inventory-production" });
    expect((await handler.handle(message, { ...contentSender, id: "other-extension" })).ok).toBe(false);
    expect((await handler.handle(message, {
      id: "extension-id", tab: { url: "https://evil.example.invalid" }
    })).ok).toBe(false);
    expect((await handler.handle(request("redmine.profile.get.v1", {
      profileId: "inventory-production", url: "https://evil.example.invalid/issues.json"
    }), contentSender)).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Redmine 401でinvalid-keyを返し保存済みcredentialをlockする", async () => {
    const storage = fakeStorage({
      local: { "feedback.redmine.v1.profiles": extensionProfiles },
      session: { "feedback.redmine.v1:inventory-production:credential": "expired-key" }
    });
    const handler = createHandler(storage, vi.fn<RedmineFetch>().mockResolvedValue(new Response("denied", { status: 401 })));
    const response = await handler.handle(request("redmine.current-user.get.v1", { profileId: "inventory-production" }), contentSender);
    expect(response).toMatchObject({ ok: false, error: { code: "redmine.invalid_api_key" } });
    expect(JSON.stringify(storage.session.data)).not.toContain("expired-key");
  });

  it("attachment Portの401もinvalid-keyのまま返しcredentialをlockする", async () => {
    const storage = fakeStorage({
      local: { "feedback.redmine.v1.profiles": extensionProfiles },
      session: { "feedback.redmine.v1:inventory-production:credential": "expired-key" }
    });
    const handler = createHandler(storage, vi.fn<RedmineFetch>().mockResolvedValue(new Response("denied", { status: 401 })));
    const message = request("redmine.attachment.get.v1", {
      profileId: "inventory-production",
      resourceRef: { schemaVersion: "1", kind: "record", key: "order-1" },
      threadId: "00000000-0000-4000-8000-000000000001",
      attachmentId: 1
    });
    let thrown: unknown;
    try { await handler.getAttachment(message, contentSender, new AbortController().signal); }
    catch (error) { thrown = error; }
    const response = await handler.failure(message, thrown);
    expect(response).toMatchObject({ ok: false, error: { code: "redmine.invalid_api_key" } });
    expect(JSON.stringify(storage.session.data)).not.toContain("expired-key");
  });

  it("evidence Port開始前にprofile MIME・byte上限・filenameを検証する", async () => {
    const storage = fakeStorage({ local: { "feedback.redmine.v1.profiles": extensionProfiles } });
    const handler = createHandler(storage, vi.fn<RedmineFetch>());
    const base = {
      filename: "feedback-00000000-0000-4000-8000-000000000001.png",
      contentType: "image/png",
      byteSize: 4,
      sha256: "a".repeat(64),
      viewportWidth: 1,
      viewportHeight: 1,
      pixelRatio: 1,
      capturedAt: "2026-08-19T00:00:00Z"
    };
    await expect(handler.authorizeEvidenceStart("inventory-production", base, contentSender)).resolves.toEqual(base);
    await expect(handler.authorizeEvidenceStart("inventory-production", {
      ...base,
      filename: "feedback-00000000-0000-4000-8000-000000000001.webp",
      contentType: "image/webp"
    }, contentSender)).rejects.toMatchObject({ code: "redmine.payload_too_large" });
    await expect(handler.authorizeEvidenceStart("inventory-production", {
      ...base,
      byteSize: 1_048_577
    }, contentSender)).rejects.toMatchObject({ code: "redmine.payload_too_large" });
    await expect(handler.authorizeEvidenceStart("inventory-production", {
      ...base,
      filename: "arbitrary.png"
    }, contentSender)).rejects.toThrow(/filename/u);
  });
});

function createHandler(storage: ReturnType<typeof fakeStorage>, fetch: RedmineFetch) {
  return new ExtensionMessageHandler(
    "extension-id", new ExtensionProfileRepository(storage), new CredentialVault(storage), new EvidenceStaging(), fetch
  );
}
function request(type: string, payload: unknown) {
  return { contractVersion: "1", requestId: "00000000-0000-4000-8000-000000000001", type, payload };
}
function json(value: unknown) { return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }); }
