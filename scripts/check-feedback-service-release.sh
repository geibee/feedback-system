#!/usr/bin/env bash
# Feedback Service runtime release候補のmanifest、checksum、multi-architecture OCIを検証する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

release_tmp=$(mktemp -d -t feedback-service-release-check.XXXXXX)
cleanup() {
  if [[ -d "$release_tmp" && "$(basename "$release_tmp")" == feedback-service-release-check.?????? ]]; then
    rm -rf -- "$release_tmp"
  fi
}
trap cleanup EXIT

version=$(node -p 'require("./package.json").version')
bash scripts/build-feedback-service-release.sh --output "$release_tmp" --version "$version"

(
  cd "$release_tmp"
  sha256sum --check feedback-service-SHA256SUMS >/dev/null
)

RELEASE_DIRECTORY="$release_tmp" EXPECTED_VERSION="$version" node <<'NODE'
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const directory = process.env.RELEASE_DIRECTORY;
const manifest = JSON.parse(readFileSync(join(directory, "feedback-service-release-manifest.json"), "utf8"));
if (manifest.schemaVersion !== "1" || manifest.product !== "feedback-service" ||
    manifest.version !== process.env.EXPECTED_VERSION || manifest.contractVersion !== "2.0.0-alpha.2" ||
    !["clean", "dirty"].includes(manifest.sourceTreeState) ||
    manifest.runtime?.package !== "@geibee/feedback-service-runtime" ||
    manifest.runtime?.providers?.join(",") !== "jira-cloud,redmine,backlog" ||
    manifest.runtime?.topology !== "db-less") {
  throw new Error("Feedback Service release manifestが不正です");
}
if (manifest.backlogCapabilities?.create !== "recoverable" ||
    manifest.backlogCapabilities?.reply !== "recoverable" ||
    manifest.backlogCapabilities?.revision !== "recoverable" ||
    manifest.backlogCapabilities?.attachmentRead !== "unsupported" ||
    manifest.backlogCapabilities?.attachmentUpload !== "unsupported") {
  throw new Error("Backlog capability境界がrelease manifestと一致しません");
}
if (!/^sha256:[a-f0-9]{64}$/u.test(manifest.liveEvidence?.backlog?.implementationDigest || "") ||
    manifest.liveEvidence?.backlog?.cleanup !== "deleted-all-run-owned-issues") {
  throw new Error("Backlog live evidenceがrelease manifestへbindingされていません");
}
if (!Array.isArray(manifest.images) || manifest.images.length !== 1) throw new Error("OCI image数が不正です");
const [image] = manifest.images;
if (image.name !== "feedback-service-runtime" || !/^[a-f0-9]{64}$/u.test(image.sha256) ||
    !/^sha256:[a-f0-9]{64}$/u.test(image.indexDigest) ||
    image.platforms?.join(",") !== "linux/amd64,linux/arm64" || !existsSync(join(directory, image.archive)) ||
    image.reports?.length !== 2 || image.reports.some((report) =>
      !existsSync(join(directory, report.sbom)) || !existsSync(join(directory, report.vulnerabilityReport)))) {
  throw new Error("Feedback Service OCI release一覧が不正です");
}
NODE

echo "[feedback-service-release-check] PASS"
