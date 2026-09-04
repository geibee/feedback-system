import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("Feedback Redmine demo bootstrap", () => {
  it("公開runtime configとstatus導線を維持する", () => {
    const runtimeConfig = JSON.parse(
      readFileSync(resolve(root, "public/.well-known/feedback-redmine.json"), "utf8")
    ) as Record<string, unknown>;
    const html = readFileSync(resolve(root, "index.html"), "utf8");

    expect(runtimeConfig).toEqual({
      schemaVersion: "1",
      enabled: true,
      profileId: "feedback-local",
      gatewayBasePath: "/internal/feedback-redmine/v1"
    });
    expect(html).toContain('id="feedback-status" role="status"');
    expect(html).toContain('<script type="module" src="/src/main.ts"></script>');
  });

  it("初期化取消とpage破棄時のcleanupを維持する", () => {
    const source = readFileSync(resolve(root, "src/main.ts"), "utf8");

    expect(source).toContain("createRedmineFeedbackPluginControllerFromRuntimeConfig");
    expect(source).toContain("signal: initializationAbort.signal");
    expect(source).toContain('window.addEventListener("pagehide"');
    expect(source).toContain("initializationAbort.abort()");
    expect(source).toContain("feedback?.destroy()");
  });
});
