import { describe, expect, it } from "vitest";
import { defaultLocalManifest, redmineCustomFieldSpecs, validateInstallationManifest } from "./manifest.js";

describe("Redmine installation manifest", () => {
  it("customer manifestはHTTPSと名前指定だけを受ける", () => {
    const manifest = { ...defaultLocalManifest(), redmineBaseUrl: "https://redmine.example.test" };
    expect(validateInstallationManifest(manifest)).toEqual(manifest);
    expect(() => validateInstallationManifest(defaultLocalManifest())).toThrow(/HTTPS/u);
    expect(validateInstallationManifest(defaultLocalManifest(), { allowHttp: true }).profileId).toBe("feedback-local");
    expect(() => validateInstallationManifest({ ...manifest, projectId: 12 })).toThrow(/unknown property/u);
    expect(() => validateInstallationManifest({ ...manifest, apiKey: "secret" })).toThrow(/unknown property/u);
  });

  it("11個のcustom field仕様を固定する", () => {
    expect(Object.keys(redmineCustomFieldSpecs)).toHaveLength(11);
    expect(redmineCustomFieldSpecs.locator).toEqual({ name: "Feedback Locator", format: "text", filter: false });
  });
});
