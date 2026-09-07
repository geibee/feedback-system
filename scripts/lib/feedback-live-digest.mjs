// 公開HTTP契約からproviderまで、live試験が通る実装全体を証跡へ束縛する。
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function feedbackLiveDigest(provider, root = fileURLToPath(new URL("../../", import.meta.url))) {
  if (!["jira-cloud", "backlog"].includes(provider)) throw new Error("live digest providerが不正です");
  const files = ["package-lock.json", "contracts/feedback/feedback-gateway.openapi.yaml", "contracts/feedback/thread-reference.md",
    "scripts/lib/feedback-live-digest.mjs", "scripts/lib/feedback-reference-acceptance.mjs", "scripts/lib/feedback-duplicate-acceptance.mjs",
    provider === "backlog" ? "scripts/run-feedback-backlog-live-conformance.mjs" : "scripts/run-feedback-jira-live-acceptance.mjs"];
  if (provider === "jira-cloud") files.push("scripts/lib/feedback-jira-live-ownership.mjs");
  const packages = ["contracts/feedback", "apps/feedback-service", "apps/feedback-service-runtime",
    ...["client", "envelope", "gateway", "connector-sdk", `connector-${provider}`].map((name) => `packages/feedback-${name}`)];
  const walk = (path) => {
    for (const entry of readdirSync(resolve(root, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(entry.name)) files.push(child);
    }
  };
  for (const path of packages) { files.push(`${path}/package.json`); walk(`${path}/src`); }
  walk("contracts/feedback/schemas");
  const hash = createHash("sha256");
  for (const path of files.sort()) hash.update(path).update("\0").update(readFileSync(resolve(root, path))).update("\0");
  return `sha256:${hash.digest("hex")}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(feedbackLiveDigest(process.argv[2]));
}
