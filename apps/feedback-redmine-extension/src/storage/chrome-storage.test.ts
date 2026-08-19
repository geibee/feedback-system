import { describe, expect, it } from "vitest";
import { fakeStorage } from "../fake-storage.test-helper.js";
import { extensionProfile, extensionProfiles } from "../test-fixtures.js";
import {
  ExtensionProfileRepository,
  restrictExtensionStorage,
  TrustedChromeClientState
} from "./chrome-storage.js";

describe("trusted Chrome storage", () => {
  it("local/session/managed accessをtrusted contextsへ制限する", async () => {
    const storage = fakeStorage();
    await restrictExtensionStorage(storage);
    expect(storage.local.accessLevels).toEqual(["TRUSTED_CONTEXTS"]);
    expect(storage.session.accessLevels).toEqual(["TRUSTED_CONTEXTS"]);
    expect(storage.managed.accessLevels).toEqual(["TRUSTED_CONTEXTS"]);
  });

  it("同一IDではmanaged profileをlocalより優先する", async () => {
    const storage = fakeStorage({
      local: { "feedback.redmine.v1.profiles": extensionProfiles },
      managed: { profiles: JSON.stringify({
        schemaVersion: "1",
        profiles: [{ ...extensionProfile, displayName: "Managed Inventory" }]
      }) }
    });
    const result = await new ExtensionProfileRepository(storage).list();
    expect(result).toHaveLength(1);
    expect(result[0]?.displayName).toBe("Managed Inventory");
  });

  it("profile削除時に関連local/session stateだけを削除する", async () => {
    const storage = fakeStorage({
      local: {
        "feedback.redmine.v1.profiles": extensionProfiles,
        "feedback.redmine.v1:inventory-production:scope:follow:1": { body: false },
        "unrelated": "keep"
      },
      session: {
        "feedback.redmine.v1:inventory-production:credential": "secret-key",
        "unrelated": "keep"
      }
    });
    await new ExtensionProfileRepository(storage).removeLocal("inventory-production");
    expect(JSON.stringify(storage.local.data)).not.toContain("body");
    expect(JSON.stringify(storage.session.data)).not.toContain("secret-key");
    expect(storage.local.data.unrelated).toBe("keep");
  });

  it("draftとpending intentをprincipal scopeで分離し期限切れintentを削除する", async () => {
    const storage = fakeStorage();
    const state = new TrustedChromeClientState(storage);
    await state.setDraft("inventory-production", "a".repeat(64), "利用者A");
    expect(await state.getDraft("inventory-production", "a".repeat(64))).toBe("利用者A");
    expect(await state.getDraft("inventory-production", "b".repeat(64))).toBeNull();
    await state.setPendingIntent("inventory-production", "a".repeat(64), {
      schemaVersion: "1",
      profileId: "inventory-production",
      threadId: "00000000-0000-4000-8000-000000000001",
      intentId: "00000000-0000-4000-8000-000000000002",
      clientDraftHash: "c".repeat(64),
      createdAt: "2000-01-01T00:00:00Z",
      state: "prepared"
    });
    expect(await state.getPendingIntent("inventory-production", "a".repeat(64))).toBeNull();
    expect(JSON.stringify(storage.local.data)).not.toContain("00000000-0000-4000-8000-000000000001");
  });
});
