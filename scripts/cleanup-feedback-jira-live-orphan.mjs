#!/usr/bin/env node
// live runnerが追跡できなかった可能性があるrun-owned issueを厳密照合して削除する。
const siteUrl = origin(required("FEEDBACK_JIRA_ACCEPTANCE_SITE_URL"));
const projectKey = stableKey(required("FEEDBACK_JIRA_ACCEPTANCE_PROJECT_KEY"));
const email = required("FEEDBACK_JIRA_ACCEPTANCE_EMAIL");
const apiToken = required("FEEDBACK_JIRA_ACCEPTANCE_API_TOKEN");
const executedAt = new Date(required("FEEDBACK_JIRA_ORPHAN_EXECUTED_AT"));
if (!Number.isFinite(executedAt.valueOf())) throw new Error("orphan実行時刻が不正です");
if (process.env.FEEDBACK_JIRA_ACCEPTANCE_CLEANUP_POLICY !== "delete-run-owned") {
  throw new Error("FEEDBACK_JIRA_ACCEPTANCE_CLEANUP_POLICY=delete-run-ownedが必要です");
}
const authorization = `Basic ${Buffer.from(`${email}:${apiToken}`, "utf8").toString("base64")}`;
const issues = await searchIssues();
const candidates = [];
for (const issue of issues) {
  const candidate = await validateCandidate(issue);
  if (candidate) candidates.push(candidate);
}
if (candidates.length > 1) throw new Error(`対象時刻のrun-owned orphan候補が複数あります: ${candidates.length}`);
if (process.argv.includes("--delete-run-owned")) {
  for (const issue of candidates) {
    const response = await jira(`/rest/api/3/issue/${encodeURIComponent(issue.id)}?deleteSubtasks=true`, { method: "DELETE" });
    if (response.status !== 204 && response.status !== 404) throw new Error(`orphan削除がstatus ${response.status}で失敗しました`);
  }
}
process.stdout.write(`${JSON.stringify({
  kind: "jira-live-orphan-cleanup",
  executedAt: new Date().toISOString(),
  tenantIdentifiersRemoved: true,
  matchedRunOwnedIssues: candidates.length,
  deletedRunOwnedIssues: process.argv.includes("--delete-run-owned") ? candidates.length : 0
})}\n`);

async function searchIssues() {
  const response = await jira("/rest/api/3/search/jql", {
    method: "POST",
    body: JSON.stringify({
      jql: `project = ${projectKey} AND summary ~ \"\\\"HTTP reference acceptance\\\"\" ORDER BY created DESC`,
      fields: ["summary", "created", "description"],
      maxResults: 100
    })
  });
  if (!response.ok) throw new Error(`orphan候補検索がstatus ${response.status}で失敗しました`);
  const body = await response.json();
  if (!Array.isArray(body?.issues) || body.isLast === false || body.nextPageToken) {
    throw new Error("orphan候補検索が一頁で完了しません");
  }
  return body.issues;
}

async function validateCandidate(issue) {
  if (!issue || typeof issue.id !== "string" || !issue.fields) return null;
  const match = /^\[feedback-phase5:([0-9a-f-]{36})\] HTTP reference acceptance$/u.exec(issue.fields.summary ?? "");
  if (!match) return null;
  const created = new Date(issue.fields.created);
  if (!Number.isFinite(created.valueOf()) || Math.abs(created.valueOf() - executedAt.valueOf()) > 5 * 60_000) return null;
  if (adfText(issue.fields.description) !== "参照経路の初期本文") return null;
  const response = await jira(`/rest/api/3/issue/${encodeURIComponent(issue.id)}/properties/${encodeURIComponent("com.geibee.feedback.recovery.v2")}`);
  if (!response.ok) return null;
  const property = (await response.json())?.value;
  if (!property || property.schemaVersion !== "2" || property.state !== "bound" ||
      property.scope?.workspaceId !== projectKey || property.scope?.resource?.kind !== "record" ||
      property.scope.resource.key !== `reference-${match[1]}` ||
      typeof property.threadId !== "string" || typeof property.intentId !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(property.requestHash ?? "")) return null;
  return { id: issue.id };
}

function adfText(value) {
  if (!value || typeof value !== "object") return "";
  return `${typeof value.text === "string" ? value.text : ""}${Array.isArray(value.content) ? value.content.map(adfText).join("") : ""}`;
}

function jira(path, init = {}) {
  return fetch(`${siteUrl}${path}`, {
    ...init,
    headers: { Accept: "application/json", Authorization: authorization,
      ...(init.body ? { "Content-Type": "application/json" } : {}) }
  });
}
function required(name) { const value = process.env[name]; if (!value) throw new Error(`${name}がありません`); return value; }
function origin(value) { const url = new URL(value); if (url.origin !== value || url.protocol !== "https:" || url.username || url.password) throw new Error("Jira site URLが不正です"); return value; }
function stableKey(value) { if (!/^[A-Z][A-Z0-9_]{1,127}$/u.test(value)) throw new Error("Jira project keyが不正です"); return value; }
