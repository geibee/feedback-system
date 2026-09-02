import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadFeedbackConnectorCatalog } from "./catalog.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function catalogFile(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "feedback-runtime-catalog-"));
  directories.push(directory);
  const path = join(directory, "catalog.json");
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}

const jira = {
  id: "jira-runtime",
  connectorKey: "jira-cloud",
  siteUrl: "https://example.atlassian.net",
  application: "inventory",
  environment: "production",
  issueTypeId: "10001",
  maximumAttachmentBytes: 1024,
  attachmentContentTypes: ["text/plain"],
  timeoutMilliseconds: 1000,
  pageSize: 50,
  recoveryRetryAfterSeconds: 10
};

describe("read-only Connector catalog", () => {
  it("exactなJira Cloud profileだけを読込む", async () => {
    const catalog = await loadFeedbackConnectorCatalog(await catalogFile({ schemaVersion: "1", profiles: [jira] }));
    expect(catalog.profiles.get("jira-runtime")).toMatchObject({ connectorKey: "jira-cloud", application: "inventory" });
    expect(() => (catalog.profiles as Map<string, unknown>).set("other", {})).toThrow();
    expect(() => (catalog.profiles.get("jira-runtime")!.attachmentContentTypes as string[]).push("image/png")).toThrow();
  });

  it("Backlog profileを同じregistryから読込み4 custom fieldをfreezeする", async () => {
    const backlog = {
      id: "backlog-runtime", connectorKey: "backlog", baseUrl: "https://example.backlog.com",
      application: "inventory", environment: "production", workspaceId: "FBSTAGEA",
      workspaceDisplayName: "Feedback", projectId: 1, issueTypeId: 2, priorityId: 3,
      maximumAttachmentBytes: 1, attachmentContentTypes: [], maximumMetadataBytes: 32768,
      timeoutMilliseconds: 30000, pageSize: 100, recoveryRetryAfterSeconds: 5,
      customFieldIds: { threadId: 11, intentId: 12, requestHash: 13, resourceKey: 14 }
    };
    const catalog = await loadFeedbackConnectorCatalog(await catalogFile({ schemaVersion: "1", profiles: [backlog] }));
    expect(catalog.profiles.get("backlog-runtime")).toMatchObject({ connectorKey: "backlog", workspaceId: "FBSTAGEA" });
    expect(() => ((catalog.profiles.get("backlog-runtime") as typeof backlog).customFieldIds.threadId = 99)).toThrow();
  });

  it("unknown field、HTTP site、重複profileを起動前に拒否する", async () => {
    await expect(loadFeedbackConnectorCatalog(await catalogFile({ schemaVersion: "1", profiles: [{ ...jira, extra: true }] }))).rejects.toThrow("unknown field");
    await expect(loadFeedbackConnectorCatalog(await catalogFile({ schemaVersion: "1", profiles: [{ ...jira, siteUrl: "http://example.test" }] }))).rejects.toThrow("HTTPS URL");
    await expect(loadFeedbackConnectorCatalog(await catalogFile({ schemaVersion: "1", profiles: [jira, jira] }))).rejects.toThrow("重複");
  });
});
