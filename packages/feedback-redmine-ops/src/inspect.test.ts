import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectRedmine } from "./inspect.js";
import { defaultLocalManifest, redmineCustomFieldSpecs } from "./manifest.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("Redmine inspect", () => {
  it("RESTを変更せず実ID、不足、手動確認項目を報告する", async () => {
    const manifestPath = await createManifest();
    const fetch = createFetch(10);
    const report = await inspectRedmine({ manifestPath, apiKey: "secret", fetch });

    expect(report.resolvedIds).toMatchObject({
      projectId: 12,
      trackerId: 3,
      roleId: 9,
      integrationUserId: 14,
      defaultPriorityId: 2,
      openStatusId: 1,
      closedStatusIds: [5]
    });
    expect(Object.keys(report.resolvedIds.customFieldIds)).toHaveLength(10);
    expect(report.checks.filter((check) => check.status === "missing")).toHaveLength(1);
    expect(report.manualChecks).toHaveLength(15);
    expect(report.manualChecks.every((check) => check.status === "unverified")).toBe(true);
    expect(report.manualCheckDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.generated).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(10);
    for (const call of fetch.mock.calls) expect(call[1]).toMatchObject({ redirect: "error" });
  });

  it("現在のdigestを明示承認した場合だけprofileを生成する", async () => {
    const manifestPath = await createManifest();
    const fetch = createFetch(Object.keys(redmineCustomFieldSpecs).length);
    const unaccepted = await inspectRedmine({ manifestPath, apiKey: "temporary-admin-secret", fetch });

    expect(unaccepted.checks.every((check) => check.status === "ok")).toBe(true);
    expect(unaccepted.generated).toBeNull();
    expect(unaccepted.manualChecks.every((check) => check.status === "unverified")).toBe(true);

    const accepted = await inspectRedmine({
      manifestPath,
      apiKey: "temporary-admin-secret",
      acceptedManualCheckDigest: unaccepted.manualCheckDigest,
      fetch
    });
    expect(accepted.manualCheckDigest).toBe(unaccepted.manualCheckDigest);
    expect(accepted.manualChecks.every((check) => check.status === "accepted")).toBe(true);
    expect(accepted.generated).not.toBeNull();
    expect(JSON.stringify(accepted)).not.toContain("temporary-admin-secret");
  });

  it("Redmineのversionまたは実IDが変わるとdigestも変わる", async () => {
    const manifestPath = await createManifest();
    const first = await inspectRedmine({ manifestPath, apiKey: "secret", fetch: createFetch(11, "6.1.3", 12) });
    const versionChanged = await inspectRedmine({ manifestPath, apiKey: "secret", fetch: createFetch(11, "7.0.0", 12) });
    const idChanged = await inspectRedmine({ manifestPath, apiKey: "secret", fetch: createFetch(11, "6.1.3", 120) });

    expect(first.manualCheckDigest).not.toBe(versionChanged.manualCheckDigest);
    expect(first.manualCheckDigest).not.toBe(idChanged.manualCheckDigest);
  });

  it("不正な承認digestを拒否する", async () => {
    const manifestPath = await createManifest();
    await expect(inspectRedmine({
      manifestPath,
      apiKey: "secret",
      acceptedManualCheckDigest: "ABC",
      fetch: createFetch(11)
    })).rejects.toThrow("小文字hexのSHA-256");
  });
});

async function createManifest(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "feedback-redmine-inspect-"));
  directories.push(directory);
  const manifestPath = join(directory, "installation.json");
  await writeFile(manifestPath, JSON.stringify({
    ...defaultLocalManifest(),
    redmineBaseUrl: "https://redmine.example.test"
  }));
  return manifestPath;
}

function createFetch(fieldCount: number, version = "6.1.3", projectId = 12) {
  const fields = Object.entries(redmineCustomFieldSpecs).slice(0, fieldCount).map(([, spec], index) => ({
    id: 20 + index,
    name: spec.name,
    field_format: spec.format
  }));
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const body = path === "/users/current.json" ? {
      _feedbackRedmineVersion: version,
      user: { id: 4, login: "feedback", admin: false }
    }
      : path === "/projects/feedback-local.json" ? { project: { id: projectId, name: "Feedback Local" } }
      : path === "/projects/feedback-local/memberships.json" ? {
        memberships: [{ user: { id: 14 }, roles: [{ id: 9, name: "Feedback integration" }] }]
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
