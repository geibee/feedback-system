#!/usr/bin/env bash
# Jira Cloud／Redmine／Backlog Connectorを含むFeedback Service runtimeのrelease候補を生成する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

output=""
version=${FEEDBACK_RELEASE_VERSION:-}

usage() {
  echo "usage: scripts/build-feedback-service-release.sh --output <empty-directory> --version <semver>" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) [[ $# -ge 2 ]] || usage; output=$2; shift 2 ;;
    --version) [[ $# -ge 2 ]] || usage; version=$2; shift 2 ;;
    *) usage ;;
  esac
done

[[ -n "$output" && "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]] || usage
for command in node npm docker trivy jq tar sha256sum stat; do
  command -v "$command" >/dev/null 2>&1 || { echo "$command が必要です" >&2; exit 1; }
done
docker buildx version >/dev/null 2>&1 || { echo "Docker Buildxが必要です" >&2; exit 1; }

EXPECTED_VERSION="$version" node <<'NODE'
const { readFileSync } = require("node:fs");
const root = JSON.parse(readFileSync("package.json", "utf8"));
if (root.version !== process.env.EXPECTED_VERSION) {
  throw new Error(`root versionがrelease versionと一致しません: ${root.version}`);
}
for (const workspace of root.workspaces) {
  const file = `${workspace}/package.json`;
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (value.version !== process.env.EXPECTED_VERSION) {
    throw new Error(`${file}のversionがrelease versionと一致しません: ${value.version}`);
  }
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, dependencyVersion] of Object.entries(value[section] || {})) {
      if (name.startsWith("@geibee/feedback-") && dependencyVersion !== process.env.EXPECTED_VERSION) {
        throw new Error(`${file}の${name}がrelease versionと一致しません: ${dependencyVersion}`);
      }
    }
  }
}
NODE

source_tree_state=clean
if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  source_tree_state=dirty
fi

if [[ -e "$output" ]]; then
  [[ -d "$output" && -z "$(find "$output" -mindepth 1 -maxdepth 1 -print -quit)" ]] || {
    echo "出力先は空directoryで指定してください: $output" >&2
    exit 1
  }
else
  mkdir -p "$output"
fi
output=$(cd "$output" && pwd)

release_root=$(mktemp -d -t feedback-service-release.XXXXXX)
release_builder=feedback-service-release-$$
buildkit_image=moby/buildkit@sha256:0168606be2315b7c807a03b3d8aa79beefdb31c98740cebdffdfeebf31190c9f
cleanup() {
  docker buildx rm "$release_builder" >/dev/null 2>&1 || true
  if [[ -d "$release_root" && "$(basename "$release_root")" == feedback-service-release.?????? ]]; then
    rm -rf -- "$release_root"
  fi
}
trap cleanup EXIT

layout="$release_root/feedback-service-runtime"
archive="feedback-service-runtime_${version}_linux_multiarch.oci.tar"
mkdir -p "$layout"
docker buildx create --driver docker-container --driver-opt "image=$buildkit_image" \
  --name "$release_builder" >/dev/null
revision=$(git rev-parse HEAD)
source_date_epoch=$(git show -s --format=%ct "$revision")
docker buildx build \
  --builder "$release_builder" \
  --platform linux/amd64,linux/arm64 \
  --build-arg "VERSION=$version" \
  --build-arg "REVISION=$revision" \
  --build-arg "SOURCE_DATE_EPOCH=$source_date_epoch" \
  --file apps/feedback-service-runtime/Dockerfile \
  --provenance=false \
  --output "type=oci,dest=$layout,tar=false,rewrite-timestamp=true,compatibility-version=30" \
  .

reports='[]'
for platform in linux/amd64 linux/arm64; do
  suffix=${platform//\//_}
  vulnerability="feedback-service-runtime_${version}_${suffix}.trivy.sarif"
  sbom="feedback-service-runtime_${version}_${suffix}.cdx.json"
  trivy image --quiet --input "$layout" --platform "$platform" --scanners vuln \
    --severity HIGH,CRITICAL --exit-code 0 --format sarif --output "$output/$vulnerability"
  trivy image --quiet --input "$layout" --platform "$platform" --scanners vuln \
    --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 --format json --output /dev/null
  trivy image --quiet --input "$layout" --platform "$platform" \
    --format cyclonedx --output "$output/$sbom"
  reports=$(jq -c --arg platform "$platform" --arg vulnerability "$vulnerability" --arg sbom "$sbom" \
    '. + [{platform:$platform,vulnerabilityReport:$vulnerability,sbom:$sbom}]' <<<"$reports")
done

tar --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 -C "$layout" -cf "$output/$archive" .
archive_sha256=$(sha256sum "$output/$archive" | awk '{print $1}')
archive_bytes=$(stat -c '%s' "$output/$archive")
index_digest=$(jq -er '.manifests[0].digest | select(test("^sha256:[a-f0-9]{64}$"))' "$layout/index.json")

RELEASE_VERSION="$version" RELEASE_REVISION="$revision" RELEASE_SOURCE_TREE_STATE="$source_tree_state" RELEASE_ARCHIVE="$archive" \
RELEASE_ARCHIVE_SHA256="$archive_sha256" RELEASE_ARCHIVE_BYTES="$archive_bytes" \
RELEASE_INDEX_DIGEST="$index_digest" RELEASE_REPORTS="$reports" RELEASE_OUTPUT="$output" node <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const openapi = readFileSync("contracts/feedback/feedback-gateway.openapi.yaml", "utf8");
const contractVersion = /^\s*version:\s*([^\s]+)\s*$/mu.exec(openapi)?.[1];
if (!contractVersion) throw new Error("OpenAPI contract versionを解決できません");
const jira = JSON.parse(readFileSync("tests/fixtures/jira-cloud-phase5/live-acceptance.json", "utf8"));
const backlog = JSON.parse(readFileSync("tests/fixtures/backlog-stage-b/live-conformance.json", "utf8"));
const manifest = {
  schemaVersion: "1",
  product: "feedback-service",
  version: process.env.RELEASE_VERSION,
  revision: process.env.RELEASE_REVISION,
  sourceTreeState: process.env.RELEASE_SOURCE_TREE_STATE,
  contractVersion,
  runtime: {
    package: "@geibee/feedback-service-runtime",
    providers: ["jira-cloud", "redmine", "backlog"],
    topology: "db-less"
  },
  backlogCapabilities: {
    create: "recoverable",
    reply: "recoverable",
    revision: "recoverable",
    attachmentRead: "unsupported",
    attachmentUpload: "unsupported"
  },
  liveEvidence: {
    jiraCloud: {
      executedAt: jira.executedAt,
      implementationDigest: jira.implementationDigest,
      cleanup: jira.cleanup
    },
    backlog: {
      executedAt: backlog.executedAt,
      implementationDigest: backlog.implementationDigest,
      cleanup: backlog.cleanup
    }
  },
  images: [{
    name: "feedback-service-runtime",
    archive: process.env.RELEASE_ARCHIVE,
    sha256: process.env.RELEASE_ARCHIVE_SHA256,
    indexDigest: process.env.RELEASE_INDEX_DIGEST,
    bytes: Number(process.env.RELEASE_ARCHIVE_BYTES),
    platforms: ["linux/amd64", "linux/arm64"],
    reports: JSON.parse(process.env.RELEASE_REPORTS)
  }],
  signingTargets: ["feedback-service-SHA256SUMS", "feedback-service-release-manifest.json"]
};
writeFileSync(`${process.env.RELEASE_OUTPUT}/feedback-service-release-manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

(
  cd "$output"
  checksum_file="$release_root/feedback-service-SHA256SUMS"
  find . -maxdepth 1 -type f ! -name feedback-service-SHA256SUMS -printf '%P\n' | \
    LC_ALL=C sort | xargs sha256sum >"$checksum_file"
  mv "$checksum_file" feedback-service-SHA256SUMS
  sha256sum --check feedback-service-SHA256SUMS >/dev/null
)

echo "[feedback-service-release] PASS: $output"
