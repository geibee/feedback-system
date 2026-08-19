import { describe, expect, it, vi } from "vitest";
import { fakeStorage } from "../fake-storage.test-helper.js";
import { extensionProfiles } from "../test-fixtures.js";
import { ExtensionProfileRepository } from "../storage/chrome-storage.js";
import { synchronizeContentScriptRegistration } from "./registration.js";

describe("programmatic content script registration", () => {
  it("許可済みの完全一致host originだけを登録する", async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    const scripting = {
      getRegisteredContentScripts: vi.fn().mockResolvedValue([]),
      registerContentScripts: register,
      unregisterContentScripts: vi.fn().mockResolvedValue(undefined)
    } as unknown as typeof chrome.scripting;
    const permissions = {
      contains: vi.fn(async ({ origins }: chrome.permissions.Permissions) => origins?.[0] === "https://inventory.example.invalid/*")
    };
    const repository = new ExtensionProfileRepository(fakeStorage({
      local: { "feedback.redmine.v1.profiles": extensionProfiles }
    }));
    await synchronizeContentScriptRegistration(scripting, repository, permissions);
    expect(register).toHaveBeenCalledWith([expect.objectContaining({
      matches: ["https://inventory.example.invalid/*"],
      js: ["content.js"],
      world: "ISOLATED"
    })]);
  });
});
