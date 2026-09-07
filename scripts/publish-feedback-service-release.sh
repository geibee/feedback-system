#!/usr/bin/env bash
# 検証済みFeedback Service runtime OCIをGHCRへ一度だけ公開する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

input=""
version=""
owner=${GITHUB_REPOSITORY_OWNER:-geibee}
usage() {
  echo "usage: scripts/publish-feedback-service-release.sh --input <release-directory> --version <semver>" >&2
  exit 2
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --input) [[ $# -ge 2 ]] || usage; input=$2; shift 2 ;;
    --version) [[ $# -ge 2 ]] || usage; version=$2; shift 2 ;;
    *) usage ;;
  esac
done
[[ -n "$input" && -d "$input" && "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || usage
input=$(cd "$input" && pwd)

fail() { echo "[feedback-service-publish] FAIL: $*" >&2; exit 1; }
for command in node jq rg sha256sum skopeo; do command -v "$command" >/dev/null 2>&1 || fail "$command が必要です"; done
[[ -n "${GITHUB_TOKEN:-}" && -n "${GITHUB_ACTOR:-}" ]] || fail "GITHUB_TOKENまたはGITHUB_ACTORがありません"

(cd "$input" && sha256sum --check feedback-service-SHA256SUMS >/dev/null) || fail "checksumが一致しません"
manifest="$input/feedback-service-release-manifest.json"
MANIFEST="$manifest" EXPECTED_VERSION="$version" node <<'NODE'
const { readFileSync } = require("node:fs");
const manifest = JSON.parse(readFileSync(process.env.MANIFEST, "utf8"));
if (manifest.schemaVersion !== "1" || manifest.product !== "feedback-service" ||
    manifest.version !== process.env.EXPECTED_VERSION || !Array.isArray(manifest.images) ||
    manifest.sourceTreeState !== "clean" ||
    manifest.images.length !== 1 || manifest.images[0].name !== "feedback-service-runtime" ||
    !/^sha256:[a-f0-9]{64}$/u.test(manifest.images[0].indexDigest) ||
    manifest.images[0].platforms?.join(",") !== "linux/amd64,linux/arm64") {
  throw new Error("Feedback Service release manifestが不正です");
}
NODE

printf '%s' "$GITHUB_TOKEN" | skopeo login --username "$GITHUB_ACTOR" --password-stdin ghcr.io >/dev/null
preflight_directory=$(mktemp -d -t feedback-service-publish.XXXXXX)
cleanup() {
  if [[ -d "$preflight_directory" && "$(basename "$preflight_directory")" == feedback-service-publish.?????? ]]; then
    rm -rf -- "$preflight_directory"
  fi
}
trap cleanup EXIT

resolve_digest() {
  local destination=$1 expected=$2 reported=$3
  if [[ "$reported" == "$expected" ]]; then printf '%s\n' "$reported"; return 0; fi
  if skopeo inspect --raw "$destination" >"$preflight_directory/image-raw.json" 2>/dev/null; then
    local raw_digest
    raw_digest="sha256:$(sha256sum "$preflight_directory/image-raw.json" | cut -d' ' -f1)"
    if [[ "$raw_digest" == "$expected" ]]; then printf '%s\n' "$raw_digest"; return 0; fi
  fi
  printf '%s\n' "$reported"
}

image_name=$(jq -r '.images[0].name' "$manifest")
archive=$(jq -r '.images[0].archive' "$manifest")
expected_digest=$(jq -r '.images[0].indexDigest' "$manifest")
destination="docker://ghcr.io/$owner/$image_name:$version"
if skopeo inspect --format '{{.Digest}}' "$destination" >"$preflight_directory/image.out" 2>"$preflight_directory/image.err"; then
  actual_digest=$(resolve_digest "$destination" "$expected_digest" "$(<"$preflight_directory/image.out")")
  [[ "$actual_digest" == "$expected_digest" ]] || \
    fail "同じversionに異なるdigestが存在します: expected=$expected_digest actual=$actual_digest"
  echo "[feedback-service-publish] OCI ghcr.io/$owner/$image_name:$version は同一digestのため再利用します"
else
  rg -qi 'manifest unknown|name unknown|not found' "$preflight_directory/image.err" || fail "OCI imageの存在確認に失敗しました"
  skopeo copy --all --preserve-digests "oci-archive:$input/$archive" "$destination"
  actual_digest=$(skopeo inspect --format '{{.Digest}}' "$destination")
  actual_digest=$(resolve_digest "$destination" "$expected_digest" "$actual_digest")
  [[ "$actual_digest" == "$expected_digest" ]] || \
    fail "OCI imageの公開digestが一致しません: expected=$expected_digest actual=$actual_digest"
fi

echo "[feedback-service-publish] PASS"
