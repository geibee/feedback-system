import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const repositoryRoot = resolve(new URL("../../..", import.meta.url).pathname);
const builtExtension = join(repositoryRoot, "apps/feedback-redmine-extension/dist/unpacked");
const strictCspHost = readFileSync(join(repositoryRoot, "tests/redmine-security/strict-csp-host.html"));
const hostileHostCss = readFileSync(join(repositoryRoot, "tests/redmine-security/hostile-host.css"));
const temporary = mkdtempSync(join(tmpdir(), "feedback-redmine-browser-"));
const extensionPath = join(temporary, "extension");
const userDataDirectory = join(temporary, "profile");
const { origin, server, requests } = await startHttpsServer(temporary);
cpSync(builtExtension, extensionPath, { recursive: true });

const manifestPath = join(extensionPath, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
// smoke用copyだけにpermissionを付与し、本体manifestのoptional permissionは別gateで保護する。
manifest.host_permissions = ["https://127.0.0.1/*"];
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const context = await chromium.launchPersistentContext(userDataDirectory, {
  channel: "chromium",
  headless: true,
  ignoreHTTPSErrors: true,
  args: ["--ignore-certificate-errors", `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
});

try {
  let workers = context.serviceWorkers();
  if (workers.length === 0) workers = [await context.waitForEvent("serviceworker")];
  const worker = workers[0];
  assert(worker);
  const extensionId = new URL(worker.url()).host;
  assert.match(extensionId, /^[a-p]{32}$/u);

  const profile = browserProfile(origin);
  await worker.evaluate(async (value) => {
    await chrome.storage.local.set({ "feedback.redmine.v1.profiles": { schemaVersion: "1", profiles: [value] } });
  }, profile);
  await waitUntil(async () => await worker.evaluate(async () =>
    (await chrome.scripting.getRegisteredContentScripts({ ids: ["feedback-redmine-content-v1"] })).length === 1
  ));
  const workerProbe = await worker.evaluate(async (url) => {
    try { return { status: (await fetch(url)).status }; }
    catch (error) { return { error: String(error) }; }
  }, `${origin}/redmine/users/current.json`);
  assert.equal(workerProbe.status, 200, `${JSON.stringify(workerProbe)} requests=${JSON.stringify(requests)}`);

  const options = await context.newPage();
  /** @type {string[]} */
  const optionsErrors = [];
  options.on("pageerror", (error) => optionsErrors.push(error.message));
  options.on("console", (message) => {
    if (message.type() === "error") optionsErrors.push(message.text());
  });
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.waitForTimeout(500);
  assert.equal(optionsErrors.length, 0, `options error: ${optionsErrors.join(" | ")}`);
  assert.match(await options.content(), /feedback-redmine-options/u);
  assert.equal(await options.getByRole("heading", { name: "Feedback for Redmine 設定" }).count(), 1);
  assert.match(await options.locator("body").innerText(), /API keyはbrowser sessionだけ/u);
  const unlock = await options.evaluate(async ({ profileId, apiKey }) => await chrome.runtime.sendMessage({
    contractVersion: "1",
    requestId: crypto.randomUUID(),
    type: "profile.unlock.v1",
    payload: { profileId, apiKey }
  }), { profileId: profile.id, apiKey: "session-only-browser-key" });
  assert.equal(unlock.ok, true, `${JSON.stringify(unlock)} requests=${JSON.stringify(requests)}`);

  const storageSnapshot = await worker.evaluate(async () => ({
    local: await chrome.storage.local.get(null),
    session: await chrome.storage.session.get(null)
  }));
  assert.doesNotMatch(JSON.stringify(storageSnapshot.local), /session-only-browser-key/u);
  assert.match(JSON.stringify(storageSnapshot.session), /session-only-browser-key/u);

  const host = await context.newPage();
  await host.goto(`${origin}/host/orders/1`);
  await host.waitForFunction(() => Boolean(document.querySelector("[data-feedback-redmine-extension]")?.shadowRoot));
  const shadowText = await host.locator("[data-feedback-redmine-extension]").evaluate((element) => element.shadowRoot?.textContent ?? "");
  assert.match(shadowText, /Feedback/u);
  assert.equal(await host.locator("[data-feedback-redmine-extension]").count(), 1);
  const launcherBackground = await host.locator("[data-feedback-redmine-extension]").evaluate((element) => {
    const launcher = element.shadowRoot?.querySelector(".feedback-redmine-launcher");
    if (!launcher) throw new Error("Shadow DOM launcherがありません");
    return getComputedStyle(launcher).backgroundColor;
  });
  assert.equal(launcherBackground, "rgb(23, 70, 162)");
  await host.locator("[data-feedback-redmine-extension]").evaluate((element) => {
    const launcher = element.shadowRoot?.querySelector("button[aria-label='Feedbackを開く']");
    if (!(launcher instanceof HTMLButtonElement)) throw new Error("launcherがありません");
    launcher.click();
  });
  await host.waitForFunction(() => Boolean(
    document.querySelector("[data-feedback-redmine-extension]")?.shadowRoot?.querySelector("textarea")
  ));
  const openedShadowText = await host.locator("[data-feedback-redmine-extension]").evaluate(
    (element) => element.shadowRoot?.textContent ?? ""
  );
  assert.match(openedShadowText, /Feedbackから送信できるのは最初の投稿だけ/u);
  assert.doesNotMatch(openedShadowText, /session-only-browser-key/u);
  assert(requests.some((entry) => entry === "/redmine/issues.json:session-only-browser-key"), JSON.stringify(requests));
  await host.reload();
  await host.waitForFunction(() => Boolean(document.querySelector("[data-feedback-redmine-extension]")?.shadowRoot));
  assert.equal(await host.locator("[data-feedback-redmine-extension]").count(), 1);

  const diagnostic = /** @type {{ ok: boolean; result: { entries: Array<{ operation: string }> } }} */ (await options.evaluate(async (profileId) => await chrome.runtime.sendMessage({
    contractVersion: "1",
    requestId: crypto.randomUUID(),
    type: "diagnostic.download.v1",
    payload: { profileId }
  }), profile.id));
  assert.equal(diagnostic.ok, true, JSON.stringify(diagnostic));
  assert(diagnostic.result.entries.length <= 100);
  assert(diagnostic.result.entries.some((entry) => entry.operation === "profile.unlock.v1"));
  assert(diagnostic.result.entries.some((entry) => entry.operation === "redmine.thread.list.v1"));
  assert.doesNotMatch(JSON.stringify(diagnostic), /session-only-browser-key/u);

  await options.evaluate(async (profileId) => await chrome.runtime.sendMessage({
    contractVersion: "1",
    requestId: crypto.randomUUID(),
    type: "profile.lock.v1",
    payload: { profileId }
  }), profile.id);
  const afterLock = await worker.evaluate(async () => await chrome.storage.session.get(null));
  assert.doesNotMatch(JSON.stringify(afterLock), /session-only-browser-key/u);
  process.stdout.write(`Chrome headless extension smoke PASS: ${extensionId}\n`);
} finally {
  await context.close();
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise(undefined)));
  rmSync(temporary, { recursive: true, force: true });
}

/** @param {() => Promise<boolean>} predicate @returns {Promise<void>} */
async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("content script registrationがtimeoutしました");
}

/** @param {string} baseOrigin */
function browserProfile(baseOrigin) {
  return {
    id: "browser-smoke",
    displayName: "Browser Smoke",
    applicationKey: "inventory",
    environmentKey: "test",
    externalWorkspaceKey: "browser-smoke",
    hostOrigins: [baseOrigin],
    redmineBaseUrl: `${baseOrigin}/redmine`,
    projectId: 1,
    trackerId: 1,
    isPrivate: true,
    defaultPriorityId: null,
    customFieldIds: {
      threadId: 1, requestHash: 2, applicationKey: 3, environmentKey: 4, externalWorkspaceKey: 5, pageKey: 6,
      hostResourceKey: 7, perspectiveCode: 8, locator: 9, submittedById: 10, submittedByName: 11, submissionChannel: 12
    },
    perspectives: [{ code: "ux", label: "UI/UX" }],
    capture: { enabled: true, maximumUploadBytes: 1_048_576, contentTypes: ["image/png"] },
    attachments: { maximumInlinePreviewBytes: 1_048_576, maximumDownloadBytes: 1_048_576 },
    showRedmineLink: false
  };
}

/** @param {string} directory */
async function startHttpsServer(directory) {
  const keyPath = join(directory, "server.key");
  const certificatePath = join(directory, "server.crt");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyPath, "-out", certificatePath
  ], { stdio: "ignore" });
  /** @type {string[]} */
  const requests = [];
  const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certificatePath) }, (request, response) => {
    const path = new URL(request.url ?? "/", "https://127.0.0.1").pathname;
    requests.push(`${path}:${request.headers["x-redmine-api-key"] ?? ""}`);
    if (path === "/redmine/users/current.json") {
      respondJson(response, { user: { id: 7, login: "browser", firstname: "Browser", lastname: "User" } });
      return;
    }
    if (path === "/redmine/projects/1.json") {
      respondJson(response, { project: { id: 1, name: "Browser Smoke" } });
      return;
    }
    if (path === "/redmine/issues.json") {
      respondJson(response, { issues: [], total_count: 0, offset: 0, limit: 100 });
      return;
    }
    if (path.startsWith("/host/")) {
      if (path === "/host/hostile-host.css") {
        response.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
        response.end(hostileHostCss);
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'"
      });
      response.end(strictCspHost);
      return;
    }
    respondJson(response, {}, 404);
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTPS smoke server portを取得できません");
  return { origin: `https://127.0.0.1:${address.port}`, server, requests };
}

/** @param {import("node:http").ServerResponse} response @param {unknown} value @param {number} [status] */
function respondJson(response, value, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}
