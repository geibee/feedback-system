#!/usr/bin/env bash
# 検証済みRedmine releaseをGitHub PackagesとGHCRへ一度だけ公開する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

input=""
version=""
owner=geibee
usage() {
  echo "usage: scripts/publish-feedback-redmine-release.sh --input <release-directory> --version <semver>" >&2
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

fail() { echo "[feedback-redmine-publish] FAIL: $*" >&2; exit 1; }
for command in npm jq rg sha256sum skopeo; do command -v "$command" >/dev/null 2>&1 || fail "$command が必要です"; done
[[ -n "${NODE_AUTH_TOKEN:-}" ]] || fail "NODE_AUTH_TOKENがありません"
[[ -n "${GITHUB_TOKEN:-}" && -n "${GITHUB_ACTOR:-}" ]] || fail "GITHUB_TOKENまたはGITHUB_ACTORがありません"

(cd "$input" && sha256sum --check SHA256SUMS >/dev/null) || fail "SHA256SUMSが一致しません"
MANIFEST="$input/release-manifest.json" EXPECTED_VERSION="$version" node <<'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.env.MANIFEST, "utf8"));
if (manifest.schemaVersion !== "1" || manifest.product !== "feedback-redmine" ||
    manifest.version !== process.env.EXPECTED_VERSION) throw new Error("release manifestのversionが一致しません");
if (!Array.isArray(manifest.publishOrder) || !Array.isArray(manifest.packages) ||
    manifest.publishOrder.length !== manifest.packages.length ||
    manifest.publishOrder.some((name, index) => manifest.packages[index]?.name !== name)) {
  throw new Error("package publish順が不正です");
}
if (!Array.isArray(manifest.images) || manifest.images.some((image) =>
  !/^sha256:[a-f0-9]{64}$/u.test(image.indexDigest) || !Array.isArray(image.platforms) ||
  image.platforms.join(",") !== "linux/amd64,linux/arm64")) throw new Error("OCI image manifestが不正です");
NODE

printf '%s' "$GITHUB_TOKEN" | skopeo login --username "$GITHUB_ACTOR" --password-stdin ghcr.io >/dev/null
preflight_directory=$(mktemp -d -t feedback-redmine-publish.XXXXXX)
cleanup() {
  if [[ -d "$preflight_directory" && "$(basename "$preflight_directory")" == feedback-redmine-publish.?????? ]]; then
    rm -rf -- "$preflight_directory"
  fi
}
trap cleanup EXIT

while IFS=$'\t' read -r package_name _filename; do
  if npm view "$package_name@$version" version --registry=https://npm.pkg.github.com \
      >"$preflight_directory/npm.out" 2>"$preflight_directory/npm.err"; then
    fail "$package_name@$version は既に存在します"
  fi
  if ! rg -qi 'E404|404 Not Found|not found' "$preflight_directory/npm.err"; then
    fail "$package_name の存在確認に失敗しました"
  fi
done < <(jq -r '.packages[] | [.name,.filename] | @tsv' "$input/release-manifest.json")

while IFS=$'\t' read -r image_name _archive; do
  destination="docker://ghcr.io/$owner/$image_name:$version"
  if skopeo inspect "$destination" >"$preflight_directory/image.out" 2>"$preflight_directory/image.err"; then
    fail "ghcr.io/$owner/$image_name:$version は既に存在します"
  fi
  if ! rg -qi 'manifest unknown|name unknown|not found' "$preflight_directory/image.err"; then
    fail "$image_name の存在確認に失敗しました"
  fi
done < <(jq -r '.images[] | [.name,.archive] | @tsv' "$input/release-manifest.json")

while IFS=$'\t' read -r package_name filename; do
  echo "[feedback-redmine-publish] npm $package_name@$version"
  npm publish "$input/$filename" --registry=https://npm.pkg.github.com --access public
done < <(jq -r '.packages[] | [.name,.filename] | @tsv' "$input/release-manifest.json")

while IFS=$'\t' read -r image_name archive expected_digest; do
  destination="docker://ghcr.io/$owner/$image_name:$version"
  echo "[feedback-redmine-publish] OCI ghcr.io/$owner/$image_name:$version"
  skopeo copy --all "oci-archive:$input/$archive" "$destination"
  actual_digest=$(skopeo inspect --format '{{.Digest}}' "$destination")
  [[ "$actual_digest" == "$expected_digest" ]] || \
    fail "$image_name の公開digestが一致しません: expected=$expected_digest actual=$actual_digest"
done < <(jq -r '.images[] | [.name,.archive,.indexDigest] | @tsv' "$input/release-manifest.json")

echo "[feedback-redmine-publish] PASS"
