#!/usr/bin/env bash
# Redmine SPA release manifest、checksum、公開package集合を検証する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

release_tmp=$(mktemp -d -t feedback-redmine-release-check.XXXXXX)
cleanup() {
  if [[ -d "$release_tmp" && "$(basename "$release_tmp")" == feedback-redmine-release-check.?????? ]]; then
    rm -rf -- "$release_tmp"
  fi
}
trap cleanup EXIT

bash scripts/build-feedback-redmine-release.sh --output "$release_tmp" --version 1.0.0-release-check.1

RELEASE_DIRECTORY="$release_tmp" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const directory = process.env.RELEASE_DIRECTORY;
const manifest = JSON.parse(fs.readFileSync(path.join(directory, "release-manifest.json"), "utf8"));
const expected = [
  "@feedback/contracts",
  "@feedback/core",
  "@feedback/dom-capture",
  "@feedback/react-ui",
  "@feedback/maplibre",
  "@feedback/redmine-core",
  "@feedback/redmine-react",
  "@feedback/redmine-plugin",
  "@feedback/redmine-gateway"
];
if (manifest.schemaVersion !== "1" || manifest.product !== "feedback-redmine-spa" ||
    manifest.version !== "1.0.0-release-check.1" || JSON.stringify(manifest.publishOrder) !== JSON.stringify(expected)) {
  throw new Error("Redmine release manifestが不正です");
}
if (manifest.packages.length !== expected.length || manifest.packages.some((item, index) =>
  item.name !== expected[index] || !/^[a-f0-9]{64}$/u.test(item.sha256) || !fs.existsSync(path.join(directory, item.filename)))) {
  throw new Error("Redmine release package一覧が不正です");
}
const filenames = fs.readdirSync(directory).join("\n");
if (/extension|with-react/iu.test(filenames)) throw new Error("廃止artifactがRedmine releaseへ混入しています");
NODE

(
  cd "$release_tmp"
  sha256sum --check SHA256SUMS >/dev/null
)

echo "[feedback-redmine-release-check] PASS"
