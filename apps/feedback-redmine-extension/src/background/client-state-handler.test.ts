import { describe, expect, it } from "vitest";
import { fakeStorage } from "../fake-storage.test-helper.js";
import { extensionProfiles } from "../test-fixtures.js";
import { ExtensionProfileRepository, TrustedChromeClientState } from "../storage/chrome-storage.js";
import { ClientStateMessageHandler } from "./client-state-handler.js";

const sender = { id: "extension-id", tab: { url: "https://inventory.example.invalid/orders/1" } };

describe("client state message validation", () => {
  it("outer profileとstate profileの不一致やunknown fieldを保存前に拒否する", async () => {
    const storage = fakeStorage({ local: { "feedback.redmine.v1.profiles": extensionProfiles } });
    const handler = new ClientStateMessageHandler(
      "extension-id",
      new ExtensionProfileRepository(storage),
      new TrustedChromeClientState(storage)
    );
    const state = {
      schemaVersion: "1",
      profileId: "other-profile",
      principalScopeHash: "a".repeat(64),
      threadId: "00000000-0000-4000-8000-000000000001",
      issueId: 1,
      followed: true,
      lastSeenJournalId: 0,
      lastSeenIssueUpdatedOn: "2026-08-19T00:00:00Z",
      updatedAt: "2026-08-19T00:00:00Z"
    };
    const mismatch = await handler.handle(request("client-state.follow.set.v1", {
      profileId: "inventory-production", state
    }), sender);
    expect(mismatch).toMatchObject({ ok: false, error: { code: "redmine.permission_denied" } });
    expect(JSON.stringify(storage.local.data)).not.toContain("other-profile");

    const unknown = await handler.handle({
      ...request("client-state.draft.get.v1", { profileId: "inventory-production", principalScopeHash: "a".repeat(64) }),
      url: "https://evil.invalid"
    }, sender);
    expect(unknown).toMatchObject({ ok: false });
  });

  it("20,000文字のdraftをsession storageだけへ保存する", async () => {
    const storage = fakeStorage({ local: { "feedback.redmine.v1.profiles": extensionProfiles } });
    const handler = new ClientStateMessageHandler(
      "extension-id",
      new ExtensionProfileRepository(storage),
      new TrustedChromeClientState(storage)
    );
    const response = await handler.handle(request("client-state.draft.set.v1", {
      profileId: "inventory-production", principalScopeHash: "a".repeat(64), draft: "a".repeat(20_000)
    }), sender);
    expect(response).toMatchObject({ ok: true });
    expect(JSON.stringify(storage.session.data)).toContain("a".repeat(100));
    expect(JSON.stringify(storage.local.data)).not.toContain("a".repeat(100));
  });
});

function request(type: string, payload: unknown) {
  return { contractVersion: "1", requestId: "00000000-0000-4000-8000-000000000001", type, payload };
}
