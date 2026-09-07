import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";

const repositoryRoot = resolve(new URL("../../..", import.meta.url).pathname);
const consumerDirectory = join(repositoryRoot, "tests/fixtures/feedback-web-component-vanilla/dist");
const javascript = readdirSync(join(consumerDirectory, "assets"))
  .filter((file) => file.endsWith(".js"))
  .map((file) => readFileSync(join(consumerDirectory, "assets", file), "utf8"))
  .join("\n");
assert.doesNotMatch(javascript, /react(?:-dom|\/jsx-runtime)?/iu, "標準Web Component bundleへReact runtimeを含めてはいけません");

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/favicon.ico") {
    response.writeHead(204).end();
    return;
  }
  const relative = url.pathname === "/" ? "/index.html" : url.pathname;
  if (!/^\/(?:index\.html|hostile-host\.css|assets\/[A-Za-z0-9._-]+)$/u.test(relative)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const bytes = readFileSync(join(consumerDirectory, relative));
    response.writeHead(200, {
      "Content-Type": contentType(relative),
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'nonce-phase4'; object-src 'none'; base-uri 'none'"
    });
    response.end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolvePromise(undefined));
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("renderer smoke portを取得できません");
const browser = await chromium.launch({ channel: "chromium", headless: true });

try {
  const page = await browser.newPage();
  /** @type {string[]} */
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${address.port}`);
  const element = page.locator("geibee-feedback");
  await element.waitFor();
  assert.equal(await page.evaluate(() => (/** @type {any} */ (window)).feedbackV2Fixture.subscribers()), 1);
  const launcher = element.getByRole("button", { name: "フィードバック" });
  assert.equal(await launcher.evaluate((button) => getComputedStyle(button).backgroundColor), "rgb(15, 23, 42)", "hostile host CSSをShadow DOMへ通してはいけません");
  await launcher.click();
  const dialog = element.getByRole("dialog", { name: "Inventory / Production" });
  await dialog.waitFor();
  assert.equal(await dialog.getAttribute("aria-modal"), "true");
  assert.equal(await page.evaluate(() => document.querySelector("geibee-feedback")?.shadowRoot?.activeElement?.getAttribute("aria-label")), "閉じる");

  await element.getByRole("button", { name: /vanilla browser thread/u }).click();
  await element.getByLabel("下書き").fill("browser draft");
  await element.getByRole("button", { name: "更新" }).click();
  await page.waitForFunction(() => (/** @type {any} */ (window)).feedbackV2Fixture.commands().includes("update-draft") && (/** @type {any} */ (window)).feedbackV2Fixture.commands().includes("refresh"));
  assert.deepEqual((await page.evaluate(() => (/** @type {any} */ (window)).feedbackV2Fixture.commands())).slice(0, 4), ["connect", "select-thread", "update-draft", "refresh"]);

  await dialog.press("Escape");
  assert.equal(await dialog.count(), 0);
  assert.equal(await page.evaluate(() => document.querySelector("geibee-feedback")?.shadowRoot?.activeElement?.textContent), "フィードバック");

  const callbacksBeforeDestroy = await page.evaluate(() => (/** @type {any} */ (window)).feedbackV2Fixture.callbacks());
  await page.evaluate(() => (/** @type {any} */ (window)).feedbackV2Fixture.destroy());
  assert.equal(await element.count(), 0);
  assert.equal(await page.evaluate(() => (/** @type {any} */ (window)).feedbackV2Fixture.subscribers()), 0);
  await page.evaluate(() => (/** @type {any} */ (window)).feedbackV2Fixture.emitLate());
  assert.equal(await page.evaluate(() => (/** @type {any} */ (window)).feedbackV2Fixture.callbacks()), callbacksBeforeDestroy, "destroy通知以後の遅延snapshotでcallbackを増やしてはいけません");

  await page.evaluate(() => (/** @type {any} */ (window)).feedbackV2Fixture.remount());
  await page.locator("geibee-feedback").waitFor();
  assert.equal(await page.locator("geibee-feedback").count(), 1);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise((resolvePromise) => server.close(() => resolvePromise(undefined)));
}

/** @param {string} path */
function contentType(path) {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" })[extname(path)] ?? "application/octet-stream";
}
