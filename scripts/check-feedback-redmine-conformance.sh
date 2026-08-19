#!/usr/bin/env bash
# digest固定Docker Official Imageを使うRedmine実REST matrix。欠落versionはfail-closedする。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

command -v docker >/dev/null 2>&1 || { echo "[feedback-redmine-conformance] FAIL: Dockerが必要です" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "[feedback-redmine-conformance] FAIL: docker composeが必要です" >&2; exit 1; }

npm --workspace @feedback/redmine-conformance run typecheck
npm --workspace @feedback/redmine-conformance run test
bash tests/redmine-conformance/run-local-matrix.sh

node <<'NODE'
const fs = require("node:fs");
const lock = JSON.parse(fs.readFileSync("tests/redmine-conformance/images.lock.json", "utf8"));
const missing = lock.images.filter((image) => image.availability !== "available" || !image.officialDigest);
if (missing.length) {
  console.error(`[feedback-redmine-conformance] FAIL: Docker Official Imageが欠落しています: ${missing.map((item) => item.requestedTag).join(", ")}`);
  process.exit(1);
}
NODE

echo "[feedback-redmine-conformance] PASS"
