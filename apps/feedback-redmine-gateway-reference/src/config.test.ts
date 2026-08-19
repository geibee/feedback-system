import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadReferenceGatewayConfig } from "./config.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("reference gateway config", () => {
  it("固定環境変数と参照先client profileを読み込む", () => {
    const directory = createProfileFiles();
    const config = loadReferenceGatewayConfig({
      FEEDBACK_REDMINE_GATEWAY_PROFILE_FILE: join(directory, "server.json"),
      FEEDBACK_REDMINE_GATEWAY_API_KEY: "integration-test-key",
      FEEDBACK_REDMINE_GATEWAY_SESSION_SECRET: "signed-session-test-secret",
      PORT: "9090"
    });

    expect(config.port).toBe(9090);
    expect(config.profiles.get("inventory-production")?.clientProfile.displayName).toBe("Inventory / Production");
    expect(config.secrets.get("FEEDBACK_REDMINE_GATEWAY_API_KEY")).toBe("integration-test-key");
    expect(config.sessionSecret).toBe("signed-session-test-secret");
  });

  it.each([
    ["profile file", { FEEDBACK_REDMINE_GATEWAY_API_KEY: "key", FEEDBACK_REDMINE_GATEWAY_SESSION_SECRET: "session" }],
    ["API key", { FEEDBACK_REDMINE_GATEWAY_PROFILE_FILE: "/not-used", FEEDBACK_REDMINE_GATEWAY_SESSION_SECRET: "session" }],
    ["session secret", { FEEDBACK_REDMINE_GATEWAY_PROFILE_FILE: "/not-used", FEEDBACK_REDMINE_GATEWAY_API_KEY: "key" }]
  ])("%s未設定時にfail-fastする", (_name, environment) => {
    expect(() => loadReferenceGatewayConfig(environment)).toThrow(/必須/u);
  });

  it("relative profile pathとunknown propertyを拒否する", () => {
    expect(() => loadReferenceGatewayConfig({
      FEEDBACK_REDMINE_GATEWAY_PROFILE_FILE: "server.json",
      FEEDBACK_REDMINE_GATEWAY_API_KEY: "key",
      FEEDBACK_REDMINE_GATEWAY_SESSION_SECRET: "session"
    })).toThrow(/absolute path/u);

    const directory = createProfileFiles({ arbitrary: true });
    expect(() => loadReferenceGatewayConfig({
      FEEDBACK_REDMINE_GATEWAY_PROFILE_FILE: join(directory, "server.json"),
      FEEDBACK_REDMINE_GATEWAY_API_KEY: "key",
      FEEDBACK_REDMINE_GATEWAY_SESSION_SECRET: "session"
    })).toThrow(/unknown property/u);
  });
});

function createProfileFiles(extra: Record<string, unknown> = {}): string {
  const directory = mkdtempSync(join(tmpdir(), "feedback-redmine-gateway-"));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, "client.json"), JSON.stringify({
    schemaVersion: "1",
    id: "inventory-production",
    displayName: "Inventory / Production",
    applicationKey: "inventory",
    environmentKey: "production",
    externalWorkspaceKey: "production-review",
    perspectives: [{ code: "ux", label: "UI/UX" }],
    capture: { enabled: true, maximumUploadBytes: 1_048_576, contentTypes: ["image/png"] },
    attachments: { maximumInlinePreviewBytes: 1_048_576, maximumDownloadBytes: 1_048_576 }
  }));
  writeFileSync(join(directory, "server.json"), JSON.stringify({
    profileId: "inventory-production",
    clientProfileRef: "client.json",
    redmineBaseUrl: "https://redmine.example.invalid/redmine",
    projectId: 12,
    trackerId: 4,
    isPrivate: true,
    defaultPriorityId: 2,
    customFieldIds: {
      threadId: 21,
      requestHash: 22,
      applicationKey: 23,
      environmentKey: 24,
      externalWorkspaceKey: 25,
      pageKey: 26,
      hostResourceKey: 27,
      perspectiveCode: 28,
      locator: 29,
      submittedById: 30,
      submittedByName: 31,
      submissionChannel: 32
    },
    authorizationMode: "resource-scoped",
    showRedmineLink: false,
    secretRef: "FEEDBACK_REDMINE_GATEWAY_API_KEY",
    ...extra
  }));
  return directory;
}
