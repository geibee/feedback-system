import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const artifact = readFileSync(new URL("../ops/feedback_redmine_v2_custom_fields.rb", import.meta.url), "utf8");
const packageManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { files?: string[] };

describe("Redmine v2 custom field Rails runner", () => {
  it("既存v1 fieldを維持し、全9 fieldと新規3 fieldだけを固定する", () => {
    for (const key of [
      "threadId", "intentId", "requestHash", "envelope", "projection",
      "applicationKey", "environmentKey", "externalWorkspaceKey", "hostResourceKey"
    ]) {
      expect(artifact).toContain(`"${key}" =>`);
    }
    expect(artifact).toContain("CREATION_KEYS = %w[intentId envelope projection].freeze");
    expect(artifact).toContain("既存v1 field");
  });

  it("digest確認後のapplyだけがcreateを呼び、既存fieldの更新・削除を持たない", () => {
    expect(artifact).toContain('unless confirmation == plan["planDigest"]');
    expect(artifact).toContain("create_v2_fields!(config, plan)");
    expect(artifact).toContain("IssueCustomField.transaction do");
    expect(artifact).not.toMatch(/IssueCustomField[^\n]*\.(?:destroy!?|delete(?:_all)?|update!?)/u);
    expect(artifact).not.toMatch(/\bfield\.(?:destroy!?|delete|update!?)\b/u);
    expect(artifact).not.toContain("find_or_create");
  });

  it("artifactを公開packageへ同梱する", () => {
    expect(packageManifest.files).toContain("ops");
  });
});
