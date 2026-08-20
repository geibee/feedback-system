import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInspectCommand } from "./cli.js";
import type { InspectionReport } from "./inspect.js";
import { defaultLocalManifest, redmineCustomFieldSpecs } from "./manifest.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("feedback-redmine inspect CLI", () => {
  it("手動確認、stale digest、承認済みprofile生成を終了codeで区別する", async () => {
    const directory = await createDirectory();
    const manifestPath = join(directory, "installation.json");
    const outputPath = join(directory, "inspection.json");
    const checklistPath = join(directory, "manual-checklist.md");
    const generatedPath = join(directory, "generated");
    await writeFile(manifestPath, JSON.stringify({
      ...defaultLocalManifest(),
      redmineBaseUrl: "https://redmine.example.test"
    }));
    const dependencies = {
      environment: { INSPECT_KEY: "temporary-admin-secret" },
      fetch: createFetch()
    };

    const unacceptedCode = await runInspectCommand([
      "inspect",
      "--manifest", manifestPath,
      "--api-key-env", "INSPECT_KEY",
      "--manual-checklist", checklistPath,
      "--generated-dir", generatedPath,
      "--output", outputPath
    ], dependencies);
    const unaccepted = JSON.parse(await readFile(outputPath, "utf8")) as InspectionReport;
    const checklist = await readFile(checklistPath, "utf8");
    expect(unacceptedCode).toBe(2);
    expect(unaccepted.generated).toBeNull();
    expect(checklist).toContain(unaccepted.manualCheckDigest);
    expect(checklist.match(/`workflow\.[^`]+`/gu)).toHaveLength(4);
    expect(checklist).toContain("全プロジェクト向け");
    expect(checklist).not.toContain("temporary-admin-secret");
    await expect(readdir(generatedPath)).rejects.toMatchObject({ code: "ENOENT" });

    const staleOutputPath = join(directory, "stale-inspection.json");
    const staleGeneratedPath = join(directory, "stale-generated");
    const staleCode = await runInspectCommand([
      "inspect",
      "--manifest", manifestPath,
      "--api-key-env", "INSPECT_KEY",
      "--accept-manual-checks", "0".repeat(64),
      "--generated-dir", staleGeneratedPath,
      "--output", staleOutputPath
    ], dependencies);
    expect(staleCode).toBe(1);
    await expect(readdir(staleGeneratedPath)).rejects.toMatchObject({ code: "ENOENT" });

    const acceptedOutputPath = join(directory, "accepted-inspection.json");
    const acceptedGeneratedPath = join(directory, "accepted-generated");
    const acceptedCode = await runInspectCommand([
      "inspect",
      "--manifest", manifestPath,
      "--api-key-env", "INSPECT_KEY",
      "--accept-manual-checks", unaccepted.manualCheckDigest,
      "--generated-dir", acceptedGeneratedPath,
      "--output", acceptedOutputPath
    ], dependencies);
    expect(acceptedCode).toBe(0);
    expect((await readdir(acceptedGeneratedPath)).sort()).toEqual([
      "client-profile.json",
      "runtime-config.json",
      "server-profile.json"
    ]);
    const allOutput = [
      await readFile(acceptedOutputPath, "utf8"),
      await readFile(join(acceptedGeneratedPath, "client-profile.json"), "utf8"),
      await readFile(join(acceptedGeneratedPath, "server-profile.json"), "utf8"),
      await readFile(join(acceptedGeneratedPath, "runtime-config.json"), "utf8")
    ].join("\n");
    expect(allOutput).not.toContain("temporary-admin-secret");
  });

  it("生成先の置換に失敗しても部分的なprofileを残さない", async () => {
    const directory = await createDirectory();
    const manifestPath = join(directory, "installation.json");
    const outputPath = join(directory, "inspection.json");
    const generatedPath = join(directory, "generated");
    await writeFile(manifestPath, JSON.stringify({
      ...defaultLocalManifest(),
      redmineBaseUrl: "https://redmine.example.test"
    }));
    const dependencies = { environment: { INSPECT_KEY: "secret" }, fetch: createFetch() };
    await runInspectCommand([
      "inspect", "--manifest", manifestPath, "--api-key-env", "INSPECT_KEY", "--output", outputPath
    ], dependencies);
    const report = JSON.parse(await readFile(outputPath, "utf8")) as InspectionReport;
    await mkdir(generatedPath);
    await writeFile(join(generatedPath, "既存ファイル"), "保持する\n");

    await expect(runInspectCommand([
      "inspect",
      "--manifest", manifestPath,
      "--api-key-env", "INSPECT_KEY",
      "--accept-manual-checks", report.manualCheckDigest,
      "--generated-dir", generatedPath,
      "--output", join(directory, "accepted.json")
    ], dependencies)).rejects.toThrow();
    expect(await readdir(generatedPath)).toEqual(["既存ファイル"]);
    expect((await readdir(directory)).some((name) => name.startsWith(".feedback-redmine-generated-"))).toBe(false);
  });
});

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "feedback-redmine-cli-"));
  directories.push(directory);
  return directory;
}

function createFetch() {
  const fields = Object.values(redmineCustomFieldSpecs).map((spec, index) => ({
    id: 20 + index,
    name: spec.name,
    field_format: spec.format
  }));
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = path === "/users/current.json" ? {
      _feedbackRedmineVersion: "6.1.3",
      user: { id: 4, login: "feedback", admin: false }
    }
      : path === "/projects/feedback-local.json" ? { project: { id: 12, name: "Feedback Local" } }
      : path === "/projects/feedback-local/memberships.json" ? {
        memberships: [{ user: { id: 14 }, roles: [{ id: 9 }] }]
      }
      : path === "/trackers.json" ? { trackers: [{ id: 3, name: "Feedback" }] }
      : path === "/issue_statuses.json" ? {
        issue_statuses: [{ id: 1, name: "New", is_closed: false }, { id: 5, name: "Closed", is_closed: true }]
      }
      : path === "/enumerations/issue_priorities.json" ? { issue_priorities: [{ id: 2, name: "Normal" }] }
      : path === "/roles.json" ? { roles: [{ id: 9, name: "Feedback integration" }] }
      : path === "/roles/9.json" ? {
        role: {
          id: 9,
          name: "Feedback integration",
          issues_visibility: "all",
          permissions: ["view_issues", "add_issues", "edit_issues", "add_issue_notes", "view_private_notes", "set_issues_private"]
        }
      }
      : path === "/users.json" ? {
        users: [{
          id: 14,
          login: "feedback_integration",
          firstname: "Feedback",
          lastname: "Integration",
          mail: "feedback-integration@example.invalid",
          status: 1
        }]
      }
      : { custom_fields: fields };
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  });
}
