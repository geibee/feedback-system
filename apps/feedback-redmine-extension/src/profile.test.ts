import { describe, expect, it } from "vitest";
import { validateExtensionProfiles } from "./profile.js";
import { extensionProfile, extensionProfiles } from "./test-fixtures.js";

describe("extension profile validation", () => {
  it("HTTPS origin・固定Redmine設定を受理しsecret/unknown fieldを拒否する", () => {
    expect(validateExtensionProfiles(extensionProfiles).profiles[0]?.id).toBe(extensionProfile.id);
    expect(() => validateExtensionProfiles({
      ...extensionProfiles,
      profiles: [{ ...extensionProfile, apiKey: "must-not-persist" }]
    })).toThrow(/unknown property/u);
    expect(() => validateExtensionProfiles({
      ...extensionProfiles,
      profiles: [{ ...extensionProfile, hostOrigins: ["http://inventory.example.invalid"] }]
    })).toThrow(/HTTPS/u);
    expect(() => validateExtensionProfiles({
      ...extensionProfiles,
      profiles: [{ ...extensionProfile, redmineBaseUrl: "https://evil@redmine.example.invalid" }]
    })).toThrow();
  });

  it("profile内schemaVersionを保存せずdefault priority省略をnullへ正規化する", () => {
    const { defaultPriorityId: _priority, ...withoutPriority } = extensionProfile;
    const profile = validateExtensionProfiles({ schemaVersion: "1", profiles: [withoutPriority] }).profiles[0]!;
    expect(profile.defaultPriorityId).toBeNull();
    expect(profile).not.toHaveProperty("schemaVersion");
  });
});
