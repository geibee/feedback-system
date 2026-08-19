import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("plugin consumerはReactをhost sourceでimportしない", () => {
  const source = readFileSync(new URL("../../fixtures/feedback-redmine-plugin-vanilla/src/main.ts", import.meta.url), "utf8");
  assert.match(source, /createRedmineFeedbackPlugin/u);
  assert.doesNotMatch(source, /from\s+["'](?:react|react-dom)/u);
});
