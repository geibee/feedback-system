import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("plugin consumerは単一integration moduleからloaderを使う", () => {
  const main = readFileSync(new URL("../../fixtures/feedback-redmine-plugin-vanilla/src/main.ts", import.meta.url), "utf8");
  const integration = readFileSync(
    new URL("../../fixtures/feedback-redmine-plugin-vanilla/src/feedback-redmine.ts", import.meta.url),
    "utf8"
  );
  assert.match(main, /from\s+["']\.\/feedback-redmine\.js["']/u);
  assert.match(integration, /from\s+["']@geibee\/redmine-plugin\/loader["']/u);
  assert.match(integration, /createRedmineFeedbackPluginControllerFromRuntimeConfig/u);
  assert.match(integration, /AbortController/u);
  assert.doesNotMatch(integration, /=\s*await\s+createRedmineFeedbackPluginControllerFromRuntimeConfig/u);
  assert.doesNotMatch(`${main}\n${integration}`, /from\s+["'](?:react|react-dom)/u);
});
