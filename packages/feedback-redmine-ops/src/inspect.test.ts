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
  it("RESTを変更せず実IDと不足を報告する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedback-redmine-inspect-"));
    directories.push(directory);
    const manifestPath = join(directory, "installation.json");
    await writeFile(manifestPath, JSON.stringify({ ...defaultLocalManifest(), redmineBaseUrl: "https://redmine.example.test" }));
    const fields = Object.entries(redmineCustomFieldSpecs).slice(0, 10).map(([key, spec], index) => ({
      id: 20 + index,
      name: spec.name,
      field_format: spec.format,
      key
    }));
    const fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname;
      const body = path === "/users/current.json" ? { user: { id: 4, login: "feedback", admin: false } }
        : path === "/projects/feedback-local.json" ? { project: { id: 12, name: "Feedback Local" } }
        : path === "/projects/feedback-local/memberships.json" ? {
          memberships: [{ user: { id: 14 }, roles: [{ id: 9, name: "Feedback integration" }] }]
        }
        : path === "/trackers.json" ? { trackers: [{ id: 3, name: "Feedback" }] }
        : path === "/issue_statuses.json" ? { issue_statuses: [{ id: 1, name: "New" }, { id: 5, name: "Closed" }] }
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
    const report = await inspectRedmine({ manifestPath, apiKey: "secret", fetch });
    expect(report.resolvedIds).toMatchObject({
      projectId: 12,
      trackerId: 3,
      roleId: 9,
      integrationUserId: 14,
      defaultPriorityId: 2,
      closedStatusIds: [5]
    });
    expect(Object.keys(report.resolvedIds.customFieldIds)).toHaveLength(10);
    expect(report.checks.filter((check) => check.status === "missing")).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(10);
    for (const call of fetch.mock.calls) expect(call[1]).toMatchObject({ redirect: "error" });
  });
});
