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
  capture: { enabled: true, maximumUploadBytes: 1_048_576, contentTypes: ["image/png"] },
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
/** @type {Record<string, {file: string; name?: string; isDynamicEntry?: boolean; dynamicImports?: string[]}>} */
const manifest = JSON.parse(readFileSync(join(consumerDirectory, ".vite/manifest.json"), "utf8"));
const entry = manifest["index.html"];
if (!entry) throw new Error("fixtureのVite manifestにindex entryがありません");
const lazyAssetPaths = (entry.dynamicImports ?? []).map((key) => {
  const chunk = manifest[key];
  if (!chunk?.file) throw new Error(`dynamic import先がmanifestにありません: ${key}`);
  return `/${chunk.file}`;
});
const mountAssetPath = Object.values(manifest).find((chunk) => chunk.isDynamicEntry && chunk.name === "mount")?.file;
if (!mountAssetPath) throw new Error("plugin mountのlazy chunkがmanifestにありません");
/** @type {Array<{method: string; path: string; origin: string | null; fetchSite: string | null; participant: string | null; idempotencyKey: string | null; contentType: string | null; bodyBytes: number}>} */
const requests = [];
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const body = await readBody(request);
  requests.push({
    method: request.method ?? "",
    path: url.pathname,
    origin: request.headers.origin ?? null,
    fetchSite: request.headers["sec-fetch-site"] ?? null,
    participant: headerValue(request.headers["x-feedback-participant-credential"]),
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
  if (url.pathname === "/.well-known/feedback-redmine.json") {
    return respondJson(response, {
      schemaVersion: "1",
      enabled: false,
      profileId: "inventory-production",
      gatewayBasePath: "/internal/feedback-redmine/v1"
    });
  }
  const base = "/internal/feedback-redmine/v1/profiles/inventory-production";
  if (request.method === "POST" && url.pathname === `${base}/participants`) {
    const input = JSON.parse(body.toString("utf8"));
    browserParticipantId = `${input.browserProfileId.slice(0, 14)}5${input.browserProfileId.slice(15)}`;
    return respondJson(response, { participantId: browserParticipantId, credential: `credential-${input.browserProfileId}` }, 201);
  }
  if (request.method === "GET" && url.pathname === base) return respondJson(response, {
    profile,
    capabilities: { canRead: true, canCreate: true, canReply: true, canEditOwn: true, stateReadOnly: true }
  });
  if (request.method === "GET" && url.pathname === `${base}/me`) return respondJson(response, {
    principal: { participantId: browserParticipantId, displayName: "利用者", source: "participant-credential" }
  });
  if (request.method === "GET" && url.pathname === `${base}/threads`) {
    return respondJson(response, { threads: created ? [threadSummary] : [], totalCount: created ? 1 : 0, nextCursor: null });
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
let browserParticipantId = "00000000-0000-4000-8000-000000000007";
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
  await page.addInitScript(() => {
    const active = new Set();
    const nativeSetInterval = window.setInterval.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);
    const browserWindow = /** @type {any} */ (window);
    browserWindow.__feedbackIntervalProbe = { active: () => active.size };
    /** @param {any} handler @param {number | undefined} timeout @param {...any} arguments_ */
    browserWindow.setInterval = (handler, timeout, ...arguments_) => {
      const timer = nativeSetInterval(handler, timeout, ...arguments_);
      active.add(timer);
      return timer;
    };
    /** @param {any} timer */
    browserWindow.clearInterval = (timer) => {
      active.delete(timer);
      nativeClearInterval(timer);
    };
  });
  /** @type {string[]} */
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(origin);
  await page.waitForFunction(() => (/** @type {any} */ (window)).feedbackFixture?.state() === "disabled");

  assert.equal(requests.filter(isApiRequest).length, 0, "初期disabledでgateway通信を開始してはいけません");
  assert.equal(await page.locator("[data-feedback-redmine-host]").count(), 0, "初期disabledでmount要素を作ってはいけません");
  assert(lazyAssetPaths.length > 0, "lazy chunkが少なくとも1つ必要です");
  assert(lazyAssetPaths.every((path) => !requests.some((entry) => entry.path === path)), "初期disabledでlazy chunkを読込んではいけません");

  await page.evaluate(async () => (/** @type {any} */ (window)).feedbackFixture.setEnabled(true));
  await page.waitForFunction(() => Boolean(
    document.querySelector("[data-feedback-redmine-host]")?.shadowRoot?.querySelector(".feedback-redmine-launcher")
  ));
  assert.equal(await page.locator("[data-feedback-redmine-host]").count(), 1);
  assert(requests.some((entry) => entry.path === `/${mountAssetPath}`), "enable時にmount lazy chunkを読み込む必要があります");
  try {
    await waitUntil(() => requests.some((entry) => entry.method === "GET" && entry.path.endsWith("/threads")));
  } catch {
    const shadowText = await page.locator("[data-feedback-redmine-host]").evaluate((element) => element.shadowRoot?.textContent ?? "");
    throw new Error(`plugin API初期化がtimeoutしました: errors=${JSON.stringify(errors)} shadow=${JSON.stringify(shadowText)} requests=${JSON.stringify(requests)}`);
  }
  const launcherBackground = await page.locator("[data-feedback-redmine-host]").evaluate((element) => {
    const launcher = element.shadowRoot?.querySelector(".feedback-redmine-launcher");
    return launcher ? getComputedStyle(launcher).backgroundColor : "";
  });
  assert.equal(launcherBackground, "rgb(15, 23, 42)");
  await page.locator("[data-feedback-redmine-host]").evaluate((element) => {
    const launcher = element.shadowRoot?.querySelector(".feedback-redmine-launcher");
    if (!(launcher instanceof HTMLButtonElement)) throw new Error("launcherがありません");
    launcher.click();
  });
  await page.waitForFunction(() => document.querySelector("[data-feedback-redmine-host]")?.shadowRoot?.textContent?.includes("フィードバックする場所をクリックしてください"));
  await page.mouse.click(100, 100);
  await page.waitForFunction(() => Boolean(document.querySelector("[data-feedback-redmine-host]")?.shadowRoot?.querySelector("textarea")));
  const preview = page.getByRole("img", { name: "証跡プレビュー" });
  try {
    await preview.waitFor();
  } catch {
    const shadowText = await page.locator("[data-feedback-redmine-host]").evaluate((element) => element.shadowRoot?.textContent ?? "");
    throw new Error(`証跡previewがtimeoutしました: errors=${JSON.stringify(errors)} shadow=${JSON.stringify(shadowText)}`);
  }
  const redMarkerPixels = await preview.evaluate(async (element) => {
    if (!(element instanceof HTMLImageElement)) throw new Error("証跡previewが画像ではありません");
    await element.decode();
    const canvas = document.createElement("canvas");
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("証跡previewを検査できません");
    context.drawImage(element, 0, 0);
    const scaleX = element.naturalWidth / window.innerWidth;
    const scaleY = element.naturalHeight / window.innerHeight;
    const left = Math.max(0, Math.floor(82 * scaleX));
    const top = Math.max(0, Math.floor(62 * scaleY));
    const width = Math.max(1, Math.ceil(36 * scaleX));
    const height = Math.max(1, Math.ceil(40 * scaleY));
    const pixels = context.getImageData(left, top, width, height).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] > 180 && pixels[index + 1] < 100 && pixels[index + 2] < 110 && pixels[index + 3] > 200) count += 1;
    }
    return count;
  });
  assert(redMarkerPixels > 20, "スクリーンショットへFeedback位置ピンを焼き込む必要があります");
  await page.getByLabel("最初のコメント").fill("実ブラウザからの初回投稿");
  await page.getByRole("button", { name: "Feedbackを送信" }).click();
  await page.waitForFunction(() => document.querySelector("[data-feedback-redmine-host]")?.shadowRoot?.textContent?.includes("Redmine drawer reply"));

  await page.getByRole("button", { name: "スレッドを閉じる" }).click();
  await page.getByRole("button", { name: "フィードバック", exact: true }).click();
  await page.mouse.click(100, 100);
  await page.waitForFunction(() => Boolean(document.querySelector("[data-feedback-redmine-host]")?.shadowRoot?.querySelector("textarea")));
  const retainedDraft = "feature flag無効化後も保持するdraft";
  await page.getByLabel("最初のコメント").fill(retainedDraft);
  await page.waitForFunction((draft) => Object.keys(sessionStorage).some((key) =>
    key.startsWith(`feedback.redmine.v1:${location.origin}:inventory-production:`) &&
    key.endsWith(":draft") && sessionStorage.getItem(key) === draft
  ), retainedDraft);
  await page.getByRole("button", { name: "他の人の投稿を見る", exact: true }).click();
  await page.waitForFunction(() => (/** @type {any} */ (window)).__feedbackIntervalProbe.active() > 0);

  await page.waitForTimeout(100);
  await page.evaluate(async () => (/** @type {any} */ (window)).feedbackFixture.setEnabled(false));
  assert.equal(await page.evaluate(() => (/** @type {any} */ (window)).feedbackFixture.state()), "disabled");
  assert.equal(await page.locator("[data-feedback-redmine-host]").count(), 0, "disableでcontroller所有DOMを削除する必要があります");
  assert.equal(await page.evaluate(() => (/** @type {any} */ (window)).feedbackFixture.activeSubscriptions()), 0, "disableでhost購読を解除する必要があります");
  assert.equal(await page.evaluate(() => (/** @type {any} */ (window)).__feedbackIntervalProbe.active()), 0, "disableでpolling timerを解除する必要があります");
  const disabledRequestCount = requests.filter(isApiRequest).length;
  await page.evaluate(() => (/** @type {any} */ (window)).feedbackFixture.emitHostLocationChange());
  await page.waitForTimeout(250);
  assert.equal(requests.filter(isApiRequest).length, disabledRequestCount, "disabled中にgateway通信を再開してはいけません");

  await page.evaluate(async () => (/** @type {any} */ (window)).feedbackFixture.setEnabled(true));
  await page.waitForFunction(() => Boolean(
    document.querySelector("[data-feedback-redmine-host]")?.shadowRoot?.querySelector(".feedback-redmine-launcher")
  ));
  await page.getByRole("button", { name: "フィードバック", exact: true }).click();
  await page.mouse.click(100, 100);
  await page.waitForFunction(() => Boolean(document.querySelector("[data-feedback-redmine-host]")?.shadowRoot?.querySelector("textarea")));
  assert.equal(await page.getByLabel("最初のコメント").inputValue(), retainedDraft, "re-enableでdraftを復元する必要があります");

  await page.evaluate(async () => (/** @type {any} */ (window)).feedbackFixture.setEnabled(false));
  await page.evaluate(async () => (/** @type {any} */ (window)).feedbackFixture.purgeLocalState());
  await page.evaluate(async () => (/** @type {any} */ (window)).feedbackFixture.setEnabled(true));
  await page.waitForFunction(() => Boolean(
    document.querySelector("[data-feedback-redmine-host]")?.shadowRoot?.querySelector(".feedback-redmine-launcher")
  ));
  await page.getByRole("button", { name: "フィードバック", exact: true }).click();
  await page.mouse.click(100, 100);
  await page.waitForFunction(() => Boolean(document.querySelector("[data-feedback-redmine-host]")?.shadowRoot?.querySelector("textarea")));
  assert.equal(await page.getByLabel("最初のコメント").inputValue(), "", "purge後にdraftを復元してはいけません");
  assert.equal(await page.locator("[data-feedback-redmine-host]").count(), 1, "再enable後もmountは1つだけである必要があります");

  await page.evaluate(async () => (/** @type {any} */ (window)).feedbackFixture.setEnabled(false));
  await page.evaluate((deepLinkThreadId) => {
    history.replaceState(null, "", `/?feedbackThread=${deepLinkThreadId}`);
  }, thread.threadId);
  await page.evaluate(async () => (/** @type {any} */ (window)).feedbackFixture.setEnabled(true));
  await page.waitForFunction(() => document.querySelector("[data-feedback-redmine-host]")?.shadowRoot?.textContent?.includes("Redmine drawer reply"));
  assert.equal(await page.getByRole("dialog", { name: "フィードバックスレッド" }).count(), 1,
    "Redmineのthread URLを開くと該当drawerを表示する必要があります");

  assert.deepEqual(errors, []);
  const apiRequests = requests.filter(isApiRequest);
  assert(apiRequests.some((entry) => entry.method === "GET" && entry.path.endsWith("/threads")));
  assert(apiRequests.every((entry) => entry.fetchSite === "same-origin"));
  assert(apiRequests.filter((entry) => entry.method === "GET").every((entry) => entry.origin === null || entry.origin === origin));
  const create = apiRequests.find((entry) => entry.method === "POST" && entry.path.endsWith("/threads"));
  assert(create);
  assert.equal(create.origin, origin);
  assert.equal(create.fetchSite, "same-origin");
  assert.match(create.participant ?? "", /^credential-[0-9a-f-]{36}$/u);
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

/** @param {{path: string}} entry */
function isApiRequest(entry) {
  return entry.path.startsWith("/internal/feedback-redmine/");
}

/** @param {() => boolean} predicate */
async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("timeout");
}
