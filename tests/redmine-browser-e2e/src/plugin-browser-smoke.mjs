import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";

const profile = {
  schemaVersion: "1",
  id: "inventory-production",
  displayName: "Inventory / Production",
  applicationKey: "inventory",
  environmentKey: "production",
  externalWorkspaceKey: "production-review",
  perspectives: [{ code: "ux", label: "UI/UX" }],
  capture: { enabled: false, maximumUploadBytes: 1_048_576, contentTypes: ["image/png"] },
  attachments: { maximumInlinePreviewBytes: 1_048_576, maximumDownloadBytes: 1_048_576 },
  showRedmineLink: false
};
const thread = {
  threadId: "00000000-0000-4000-8000-000000000001",
  issueId: 123,
  subject: "[ux] browser smoke",
  initialComment: "実ブラウザからの初回投稿",
  latestReply: "Redmine drawer reply",
  status: { id: 1, name: "新規" },
  priority: null,
  assignee: null,
  author: { id: 7, name: "利用者" },
  perspectiveCode: "ux",
  locator: null,
  hasAttachments: false,
  createdAt: "2026-08-19T00:00:00Z",
  updatedAt: "2026-08-19T00:01:00Z",
  description: "実ブラウザからの初回投稿",
  tracker: { id: 4, name: "Feedback" },
  timeline: [{
    kind: "reply",
    journalId: 10,
    body: "Redmine drawer reply",
    author: { id: 9, name: "返信者" },
    createdAt: "2026-08-19T00:01:00Z",
    updatedAt: null
  }],
  attachments: [],
  redmineUrl: null,
  diagnosticCount: 0
};
const threadSummary = Object.fromEntries(Object.entries(thread).filter(([key]) =>
  !["description", "tracker", "timeline", "attachments", "redmineUrl", "diagnosticCount"].includes(key)
));

const repositoryRoot = resolve(new URL("../../..", import.meta.url).pathname);
const consumerDirectory = join(repositoryRoot, "tests/fixtures/feedback-redmine-plugin-vanilla/dist");
const hostileCss = readFileSync(join(repositoryRoot, "tests/redmine-security/hostile-host.css"));
/** @type {Array<{method: string; path: string; origin: string | null; fetchSite: string | null; csrf: string | null; idempotencyKey: string | null; contentType: string | null; bodyBytes: number}>} */
const requests = [];
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const body = await readBody(request);
  requests.push({
    method: request.method ?? "",
    path: url.pathname,
    origin: request.headers.origin ?? null,
    fetchSite: request.headers["sec-fetch-site"] ?? null,
    csrf: headerValue(request.headers["x-feedback-csrf"]),
    idempotencyKey: headerValue(request.headers["idempotency-key"]),
    contentType: request.headers["content-type"] ?? null,
    bodyBytes: body.byteLength
  });
  if (url.pathname === "/hostile-host.css") {
    response.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
    response.end(hostileCss);
    return;
  }
  if (url.pathname === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }
  const base = "/internal/feedback-redmine/v1/profiles/inventory-production";
  if (request.method === "GET" && url.pathname === base) return respondJson(response, {
    profile,
    capabilities: { canRead: true, canCreate: true, repliesReadOnly: true, stateReadOnly: true }
  });
  if (request.method === "GET" && url.pathname === `${base}/me`) return respondJson(response, {
    principal: { subjectId: "subject-1", displayName: "利用者", redmineUserId: 7, source: "host-session" }
  });
  if (request.method === "GET" && url.pathname === `${base}/threads`) {
    if (url.searchParams.has("resourceKind")) return respondJson(response, { threads: created ? [threadSummary] : [], nextCursor: null });
  }
  if (request.method === "POST" && url.pathname === `${base}/threads`) {
    created = true;
    return respondJson(response, { thread }, 201);
  }
  if (request.method === "GET" && url.pathname === `${base}/threads/${thread.threadId}`) {
    return respondJson(response, { thread });
  }
  const relativePath = url.pathname === "/" ? "/index.html" : url.pathname;
  if (!/^\/(?:index\.html|assets\/[A-Za-z0-9._-]+)$/u.test(relativePath)) return respondJson(response, {}, 404);
  try {
    const bytes = readFileSync(join(consumerDirectory, relativePath));
    response.writeHead(200, { "Content-Type": contentType(relativePath) });
    response.end(bytes);
  } catch {
    respondJson(response, {}, 404);
  }
});

let created = false;
await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolvePromise(undefined));
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("plugin smoke portを取得できません");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ channel: "chromium", headless: true });

try {
  const page = await browser.newPage();
  /** @type {string[]} */
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(origin);
  await page.waitForFunction(() => Boolean(document.querySelector("#feedback-root")?.shadowRoot?.querySelector("button[aria-label='Feedbackを開く']")));
  const mountCount = await page.locator("#feedback-root").evaluate((element) =>
    element.shadowRoot?.querySelectorAll("[data-feedback-redmine-mount]").length ?? 0
  );
  assert.equal(mountCount, 1);
  try {
    await waitUntil(() => requests.some((entry) => entry.method === "GET" && entry.path.endsWith("/threads")));
  } catch {
    const shadowText = await page.locator("#feedback-root").evaluate((element) => element.shadowRoot?.textContent ?? "");
    throw new Error(`plugin API初期化がtimeoutしました: errors=${JSON.stringify(errors)} shadow=${JSON.stringify(shadowText)} requests=${JSON.stringify(requests)}`);
  }
  const launcherBackground = await page.locator("#feedback-root").evaluate((element) => {
    const launcher = element.shadowRoot?.querySelector(".feedback-redmine-launcher");
    return launcher ? getComputedStyle(launcher).backgroundColor : "";
  });
  assert.equal(launcherBackground, "rgb(23, 70, 162)");
  await page.locator("#feedback-root").evaluate((element) => {
    const launcher = element.shadowRoot?.querySelector("button[aria-label='Feedbackを開く']");
    if (!(launcher instanceof HTMLButtonElement)) throw new Error("launcherがありません");
    launcher.click();
  });
  await page.waitForFunction(() => Boolean(document.querySelector("#feedback-root")?.shadowRoot?.querySelector("textarea")));
  await page.getByLabel("最初のコメント").fill("実ブラウザからの初回投稿");
  await page.getByRole("button", { name: "最初の投稿をRedmineへ送信" }).click();
  await page.waitForFunction(() => document.querySelector("#feedback-root")?.shadowRoot?.textContent?.includes("Redmine drawer reply"));
  assert.deepEqual(errors, []);
  const apiRequests = requests.filter((entry) => entry.path.startsWith("/internal/feedback-redmine/"));
  assert(apiRequests.some((entry) => entry.method === "GET" && entry.path.endsWith("/threads")));
  assert(apiRequests.every((entry) => entry.fetchSite === "same-origin"));
  assert(apiRequests.filter((entry) => entry.method === "GET").every((entry) => entry.origin === null || entry.origin === origin));
  const create = apiRequests.find((entry) => entry.method === "POST" && entry.path.endsWith("/threads"));
  assert(create);
  assert.equal(create.origin, origin);
  assert.equal(create.fetchSite, "same-origin");
  assert.equal(create.csrf, "browser-smoke-csrf");
  assert.match(create.idempotencyKey ?? "", /^[0-9a-f-]{36}$/u);
  assert.match(create.contentType ?? "", /^multipart\/form-data; boundary=/u);
  assert(create.bodyBytes > 0);
  process.stdout.write("Chrome headless plugin smoke PASS\n");
} finally {
  await browser.close();
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise(undefined)));
}

/** @param {import("node:http").ServerResponse} response @param {unknown} value @param {number} [status] */
function respondJson(response, value, status = 200) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

/** @param {import("node:http").IncomingMessage} request @returns {Promise<Buffer>} */
async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** @param {string} path */
function contentType(path) {
  return extname(path) === ".html"
    ? "text/html; charset=utf-8"
    : extname(path) === ".js" ? "text/javascript; charset=utf-8" : "application/octet-stream";
}

/** @param {string | string[] | undefined} value */
function headerValue(value) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

/** @param {() => boolean} predicate */
async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("timeout");
}
