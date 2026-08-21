import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
/** @typedef {{version: string, requestedTag: string, officialDigest: string | null, availability: "available" | "missing-upstream"}} MatrixImage */
/** @type {{schemaVersion: "1", images: MatrixImage[]}} */
const lock = JSON.parse(readFileSync(new URL("./images.lock.json", import.meta.url), "utf8"));
const onlyVersion = process.argv.find((argument) => argument.startsWith("--only="))?.slice("--only=".length);
const selected = lock.images.filter((image) =>
  image.availability === "available" && (!onlyVersion || image.version === onlyVersion)
);
if (selected.length === 0) throw new Error("実行対象のRedmine imageがありません");

for (const image of selected) runImage(image);

/** @param {MatrixImage} image */
function runImage(image) {
  const digest = image.officialDigest;
  const expectedVersion = image.version;
  if (!digest) throw new Error(`${image.version}のimage固定情報が不足しています`);
  const runId = randomBytes(4).toString("hex");
  const project = `feedback-redmine-e2e-${runId}-${expectedVersion.replaceAll(".", "-")}`;
  const temporary = mkdtempSync(join(tmpdir(), `${project}-`));
  const conformanceSecret = randomBytes(64).toString("hex");
  const environment = {
    ...process.env,
    FEEDBACK_REDMINE_IMAGE: `docker.io/library/redmine@${digest}`,
    FEEDBACK_REDMINE_CONFORMANCE_RUN_ID: runId,
    FEEDBACK_REDMINE_CONFORMANCE_SECRET: conformanceSecret
  };
  try {
    run("docker", ["compose", "-p", project, "-f", "deploy/redmine-conformance/compose.yaml", "up", "-d", "--wait"], environment);
    const portOutput = output("docker", ["compose", "-p", project, "-f", "deploy/redmine-conformance/compose.yaml", "port", "redmine", "3000"], environment);
    const port = /:([0-9]+)\s*$/u.exec(portOutput)?.[1];
    if (!port) throw new Error(`Redmine portを取得できません: ${portOutput}`);
    const container = output("docker", ["compose", "-p", project, "-f", "deploy/redmine-conformance/compose.yaml", "ps", "-q", "redmine"], environment).trim();
    const seedPath = join(temporary, "seed.json");
    const statePath = join(temporary, "state.json");
    run("docker", ["cp", "tests/redmine-conformance/seed/setup.rb", `${container}:/usr/src/redmine/tmp/feedback-redmine-setup.rb`], environment);
    const seed = output("docker", ["exec", "-e", `SECRET_KEY_BASE=${conformanceSecret}`, container,
      "bundle", "exec", "rails", "runner", "/usr/src/redmine/tmp/feedback-redmine-setup.rb"], environment);
    writeFileSync(seedPath, seed);
    const seedFixture = parseLastJson(seed);
    const actualVersion = String(seedFixture.version);
    if (!actualVersion.startsWith(expectedVersion)) throw new Error(`Redmine version mismatch: ${actualVersion} != ${expectedVersion}`);
    run("node", ["tests/redmine-conformance/src/run.mjs", "create", `http://127.0.0.1:${port}`, seedPath, statePath], environment);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    run("docker", ["cp", "tests/redmine-conformance/seed/render-description.rb",
      `${container}:/usr/src/redmine/tmp/feedback-redmine-render-description.rb`], environment);
    const renderedOutput = output("docker", ["exec", "-e", `SECRET_KEY_BASE=${conformanceSecret}`, container,
      "bundle", "exec", "rails", "runner", "/usr/src/redmine/tmp/feedback-redmine-render-description.rb",
      String(state.issueId)], environment);
    const rendered = parseLastJson(renderedOutput);
    const expectedHref = `http://app.example/orders/%28draft%29%5B1%5D?feedbackThread=${state.threadId}`;
    const evidenceFilename = `feedback-${state.threadId}.png`;
    for (const format of ["common_mark", "textile"]) {
      const html = String(rendered[format]);
      assert(html.includes(`href="${expectedHref}"`), `${format}でthread URLがlinkになっていません: ${html}`);
      assert(html.includes(`alt="${evidenceFilename}"`), `${format}で証跡画像がdescription内に表示されていません: ${html}`);
      assert(html.includes('class="thumbnail"'), `${format}で証跡画像がclick可能なthumbnailになっていません: ${html}`);
    }
    run("docker", ["cp", "tests/redmine-conformance/seed/journals.rb", `${container}:/usr/src/redmine/tmp/feedback-redmine-journals.rb`], environment);
    run("docker", ["exec", "-e", `SECRET_KEY_BASE=${conformanceSecret}`, container,
      "bundle", "exec", "rails", "runner", "/usr/src/redmine/tmp/feedback-redmine-journals.rb", String(state.issueId),
      String(seedFixture.userId)], environment);
    run("node", ["tests/redmine-conformance/src/run.mjs", "verify", `http://127.0.0.1:${port}`, seedPath, statePath], environment);
  } finally {
    try { run("docker", ["compose", "-p", project, "-f", "deploy/redmine-conformance/compose.yaml", "down", "--volumes", "--remove-orphans"], environment); } catch {}
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** @param {string} command @param {string[]} args @param {NodeJS.ProcessEnv} environment */
function run(command, args, environment) {
  execFileSync(command, args, { cwd: root, env: environment, stdio: "inherit" });
}
/** @param {string} command @param {string[]} args @param {NodeJS.ProcessEnv} environment */
function output(command, args, environment) {
  return execFileSync(command, args, { cwd: root, env: environment, encoding: "utf8" });
}

/** @param {string} value @returns {Record<string, unknown>} */
function parseLastJson(value) {
  const lastLine = value.trim().split("\n").at(-1);
  if (!lastLine) throw new Error("Redmine seed結果が空です");
  return JSON.parse(lastLine);
}
