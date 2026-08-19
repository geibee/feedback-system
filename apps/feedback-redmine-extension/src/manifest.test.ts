import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateExtensionProfiles } from "./profile.js";

describe("Manifest V3 security", () => {
  it("required host permission・remote script・緩いCSPを持たない", () => {
    const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")) as Record<string, unknown>;
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(["storage", "scripting", "activeTab"]);
    expect(manifest).not.toHaveProperty("host_permissions");
    expect(manifest.optional_host_permissions).toEqual(["https://*/*"]);
    expect(manifest.storage).toEqual({ managed_schema: "managed-policy-schema.json" });
    expect(JSON.stringify(manifest)).not.toMatch(/unsafe-eval|https?:\/\/[^*]/u);
    expect(manifest.content_security_policy).toEqual({ extension_pages: "script-src 'self'; object-src 'self'" });
  });

  it("managed policy schemaとsampleにcredentialを含めない", () => {
    const schema = JSON.parse(readFileSync(new URL("../public/managed-policy-schema.json", import.meta.url), "utf8")) as Record<string, unknown>;
    const policy = JSON.parse(readFileSync(new URL("../managed-policy.example.json", import.meta.url), "utf8")) as { profiles: string };
    const sample = JSON.parse(readFileSync(new URL("../public/managed-profile.sample.json", import.meta.url), "utf8")) as unknown;
    expect(schema.type).toBe("object");
    expect(schema).not.toHaveProperty("additionalProperties");
    expect(JSON.parse(policy.profiles)).toEqual(sample);
    expect(validateExtensionProfiles(sample).profiles).toHaveLength(1);
    expect(JSON.stringify({ policy, sample })).not.toMatch(/api.?key|credential|secret/iu);
  });
});
