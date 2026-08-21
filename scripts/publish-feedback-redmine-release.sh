#!/usr/bin/env bash
# 検証済みRedmine releaseをregistryへ一度だけ公開する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

input=""
version=""
owner=geibee
npm_only=false
npm_registry=https://npm.pkg.github.com
npm_tag=latest
usage() {
  echo "usage: scripts/publish-feedback-redmine-release.sh --input <release-directory> --version <semver> [--npm-only] [--tag <dist-tag>]" >&2
  exit 2
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --input) [[ $# -ge 2 ]] || usage; input=$2; shift 2 ;;
    --version) [[ $# -ge 2 ]] || usage; version=$2; shift 2 ;;
    --npm-only) npm_only=true; shift ;;
    --tag) [[ $# -ge 2 ]] || usage; npm_tag=$2; shift 2 ;;
    *) usage ;;
  esac
done
[[ -n "$input" && -d "$input" && "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ &&
  "$npm_tag" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || usage
input=$(cd "$input" && pwd)

fail() { echo "[feedback-redmine-publish] FAIL: $*" >&2; exit 1; }
commands=(npm jq rg sha256sum)
if [[ "$npm_only" == true ]]; then
  npm_registry=https://registry.npmjs.org
  [[ "$(npm whoami --registry="$npm_registry" 2>/dev/null)" == "$owner" ]] || fail "npmjsへ$ownerとしてloginしていません"
else
  commands+=(skopeo)
  [[ -n "${NODE_AUTH_TOKEN:-}" ]] || fail "NODE_AUTH_TOKENがありません"
  [[ -n "${GITHUB_TOKEN:-}" && -n "${GITHUB_ACTOR:-}" ]] || fail "GITHUB_TOKENまたはGITHUB_ACTORがありません"
fi
for command in "${commands[@]}"; do command -v "$command" >/dev/null 2>&1 || fail "$command が必要です"; done

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

if [[ "$npm_only" == true ]]; then
  [[ "$(jq '.images | length' "$input/release-manifest.json")" == 0 ]] || fail "npm-only releaseへOCI imageが含まれています"
else
  printf '%s' "$GITHUB_TOKEN" | skopeo login --username "$GITHUB_ACTOR" --password-stdin ghcr.io >/dev/null
fi
preflight_directory=$(mktemp -d -t feedback-redmine-publish.XXXXXX)
cleanup() {
  if [[ -d "$preflight_directory" && "$(basename "$preflight_directory")" == feedback-redmine-publish.?????? ]]; then
    rm -rf -- "$preflight_directory"
  fi
}
trap cleanup EXIT

npm_plan="$preflight_directory/npm-plan.tsv"
image_plan="$preflight_directory/image-plan.tsv"
: >"$npm_plan"
: >"$image_plan"

fetch_npm_integrity() {
  local package_name=$1
  local attempt
  for attempt in {1..300}; do
    if npm view "$package_name@$version" dist.integrity --json --registry="$npm_registry" \
        >"$preflight_directory/npm-integrity.json" 2>"$preflight_directory/npm.err"; then
      if jq -er 'select(type == "string")' "$preflight_directory/npm-integrity.json"; then
        return 0
      fi
    fi
    if (( attempt < 300 )); then sleep 2; fi
  done
  return 1
}

fetch_npm_dist_tags() {
  local package_name=$1
  local attempt
  for attempt in {1..300}; do
    if npm view "$package_name" dist-tags --json --registry="$npm_registry" \
        >"$preflight_directory/npm-tags.json" 2>"$preflight_directory/npm.err" &&
        jq -e 'type == "object"' "$preflight_directory/npm-tags.json" >/dev/null; then
      cat "$preflight_directory/npm-tags.json"
      return 0
    fi
    if (( attempt < 300 )); then sleep 2; fi
  done
  return 1
}

reconcile_npm_tags() {
  local package_name=$1
  local tags desired_version latest_version
  tags=$(fetch_npm_dist_tags "$package_name") || fail "$package_name のdist-tagを確認できません"
  desired_version=$(jq -r --arg tag "$npm_tag" '.[$tag] // empty' <<<"$tags")
  [[ "$desired_version" == "$version" ]] || fail "$package_name の$npm_tag tagが$versionではありません"

  if [[ "$npm_tag" != latest ]]; then
    latest_version=$(jq -r '.latest // empty' <<<"$tags")
    if [[ "$latest_version" == "$version" ]]; then
      echo "[feedback-redmine-publish] npm $package_name は初回公開のためlatestも$versionを指します"
    fi
  fi
}

while IFS=$'\t' read -r package_name filename; do
  local_integrity=$(PACKAGE_FILE="$input/$filename" node -e '
    const { createHash } = require("node:crypto");
    const { readFileSync } = require("node:fs");
    process.stdout.write(`sha512-${createHash("sha512").update(readFileSync(process.env.PACKAGE_FILE)).digest("base64")}`);
  ')
  if npm view "$package_name@$version" version --registry="$npm_registry" \
      >"$preflight_directory/npm.out" 2>"$preflight_directory/npm.err"; then
    remote_integrity=$(fetch_npm_integrity "$package_name") || \
      fail "$package_name の公開済みintegrityが不正です"
    [[ "$remote_integrity" == "$local_integrity" ]] || \
      fail "$package_name@$version は異なる内容で既に存在します"
    action=skip
  else
    if ! rg -qi 'E404|404 Not Found|not found' "$preflight_directory/npm.err"; then
      fail "$package_name の存在確認に失敗しました"
    fi
    action=publish
  fi
  printf '%s\t%s\t%s\t%s\n' "$package_name" "$filename" "$local_integrity" "$action" >>"$npm_plan"
done < <(jq -r '.packages[] | [.name,.filename] | @tsv' "$input/release-manifest.json")

while [[ "$npm_only" != true ]] && IFS=$'\t' read -r image_name archive expected_digest; do
  destination="docker://ghcr.io/$owner/$image_name:$version"
  if skopeo inspect --format '{{.Digest}}' "$destination" >"$preflight_directory/image.out" 2>"$preflight_directory/image.err"; then
    actual_digest=$(<"$preflight_directory/image.out")
    [[ "$actual_digest" == "$expected_digest" ]] || \
      fail "ghcr.io/$owner/$image_name:$version は異なるdigestで既に存在します"
    action=skip
  else
    if ! rg -qi 'manifest unknown|name unknown|not found' "$preflight_directory/image.err"; then
      fail "$image_name の存在確認に失敗しました"
    fi
    action=publish
  fi
  printf '%s\t%s\t%s\t%s\n' "$image_name" "$archive" "$expected_digest" "$action" >>"$image_plan"
done < <(jq -r '.images[] | [.name,.archive,.indexDigest] | @tsv' "$input/release-manifest.json")

while IFS=$'\t' read -r package_name filename expected_integrity action <&3; do
  if [[ "$action" == skip ]]; then
    echo "[feedback-redmine-publish] npm $package_name@$version は同一integrityのため再利用します"
  else
    echo "[feedback-redmine-publish] npm $package_name@$version"
    npm publish "$input/$filename" --registry="$npm_registry" --access public --tag "$npm_tag"
  fi
done 3<"$npm_plan"

while IFS=$'\t' read -r package_name filename expected_integrity action <&3; do
  actual_integrity=$(fetch_npm_integrity "$package_name") || \
    fail "$package_name の公開後integrityを確認できません"
  [[ "$actual_integrity" == "$expected_integrity" ]] || fail "$package_name の公開後integrityが一致しません"
  reconcile_npm_tags "$package_name"
done 3<"$npm_plan"

while [[ "$npm_only" != true ]] && IFS=$'\t' read -r image_name archive expected_digest action <&3; do
  destination="docker://ghcr.io/$owner/$image_name:$version"
  if [[ "$action" == skip ]]; then
    echo "[feedback-redmine-publish] OCI ghcr.io/$owner/$image_name:$version は同一digestのため再利用します"
    continue
  fi
  if skopeo inspect --format '{{.Digest}}' "$destination" >"$preflight_directory/image.out" 2>"$preflight_directory/image.err"; then
    actual_digest=$(<"$preflight_directory/image.out")
    [[ "$actual_digest" == "$expected_digest" ]] || \
      fail "$image_name の公開直前に異なるdigestのtagが作成されました"
    echo "[feedback-redmine-publish] OCI ghcr.io/$owner/$image_name:$version は同一digestのため再利用します"
    continue
  fi
  if ! rg -qi 'manifest unknown|name unknown|not found' "$preflight_directory/image.err"; then
    fail "$image_name の公開直前確認に失敗しました"
  fi
  echo "[feedback-redmine-publish] OCI ghcr.io/$owner/$image_name:$version"
  skopeo copy --all --preserve-digests "oci-archive:$input/$archive" "$destination"
  actual_digest=$(skopeo inspect --format '{{.Digest}}' "$destination")
  [[ "$actual_digest" == "$expected_digest" ]] || \
    fail "$image_name の公開digestが一致しません: expected=$expected_digest actual=$actual_digest"
done 3<"$image_plan"

echo "[feedback-redmine-publish] PASS"
