#!/usr/bin/env bash
# Redmine正本SPA向けnpm packageを再現可能なrelease候補として生成する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

output=""
version=${FEEDBACK_RELEASE_VERSION:-}

usage() {
  echo "usage: scripts/build-feedback-redmine-release.sh --output <empty-directory> --version <semver>" >&2
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
for command in node npm tar sha256sum docker jq stat trivy; do
  command -v "$command" >/dev/null 2>&1 || { echo "$command が必要です" >&2; exit 1; }
done

if [[ -e "$output" ]]; then
  [[ -d "$output" && -z "$(find "$output" -mindepth 1 -maxdepth 1 -print -quit)" ]] || {
    echo "出力先は空directoryで指定してください: $output" >&2
    exit 1
  }
else
  mkdir -p "$output"
fi
output=$(cd "$output" && pwd)

release_root=$(mktemp -d -t feedback-redmine-release.XXXXXX)
feedback_npm_cache="$release_root/npm-cache"
mkdir -p "$feedback_npm_cache"
cleanup() {
  if [[ -d "$release_root" && "$(basename "$release_root")" == feedback-redmine-release.?????? ]]; then
    rm -rf -- "$release_root"
  fi
}
trap cleanup EXIT

packages=(
  @geibee/contracts
  @geibee/core
  @geibee/dom-capture
  @geibee/react-ui
  @geibee/maplibre
  @geibee/redmine-core
  @geibee/redmine-react
  @geibee/redmine-plugin
  @geibee/redmine-gateway
  @geibee/redmine-ops
)

npm run build:redmine

release_builder=${FEEDBACK_REDMINE_RELEASE_BUILDER:-feedback-redmine-release-$$}
oci_root="$release_root/oci"
mkdir -p "$oci_root"
docker buildx create --driver docker-container --name "$release_builder" >/dev/null
cleanup_builder() {
  docker buildx rm "$release_builder" >/dev/null 2>&1 || true
}
trap 'cleanup_builder; cleanup' EXIT

artifacts_file="$release_root/artifacts.tsv"
: >"$artifacts_file"
for package_name in "${packages[@]}"; do
  package_key=${package_name#@geibee/}
  source_dir="$release_root/source-$package_key"
  stage_dir="$release_root/stage-$package_key"
  mkdir -p "$source_dir" "$stage_dir"

  source_result=$(npm_config_cache="$feedback_npm_cache" npm --workspace "$package_name" pack --pack-destination "$source_dir" --json)
  source_tarball=$(PACK_RESULT="$source_result" node -e '
    const [result] = JSON.parse(process.env.PACK_RESULT);
    process.stdout.write(result.filename);
  ')
  tar -xzf "$source_dir/$source_tarball" -C "$stage_dir" --strip-components=1

  RELEASE_PACKAGE_VERSION="$version" node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    delete value.private;
    value.version = process.env.RELEASE_PACKAGE_VERSION;
    value.publishConfig = { registry: "https://npm.pkg.github.com", access: "public" };
    value.repository = {
      type: "git",
      url: "git+https://github.com/geibee/feedback-system.git"
    };
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const name of Object.keys(value[section] || {})) {
        if (name.startsWith("@geibee/")) value[section][name] = process.env.RELEASE_PACKAGE_VERSION;
      }
    }
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  ' "$stage_dir/package.json"

  release_result=$(npm_config_cache="$feedback_npm_cache" npm pack "$stage_dir" --pack-destination "$output" --json)
  release_tarball=$(PACK_RESULT="$release_result" node -e '
    const [result] = JSON.parse(process.env.PACK_RESULT);
    process.stdout.write(result.filename);
  ')
  tar -xOf "$output/$release_tarball" package/package.json | \
    EXPECTED_NAME="$package_name" EXPECTED_VERSION="$version" node -e '
      const fs = require("node:fs");
      const value = JSON.parse(fs.readFileSync(0, "utf8"));
      if (value.name !== process.env.EXPECTED_NAME || value.version !== process.env.EXPECTED_VERSION ||
          value.private === true || value.publishConfig?.access !== "public" ||
          value.publishConfig?.registry !== "https://npm.pkg.github.com" ||
          value.repository?.url !== "git+https://github.com/geibee/feedback-system.git") process.exit(1);
      if (value.exports?.["./self-hosted"]) process.exit(1);
    '
  digest=$(sha256sum "$output/$release_tarball" | awk '{print $1}')
  printf '%s\t%s\t%s\n' "$package_name" "$release_tarball" "$digest" >>"$artifacts_file"
done

images_file="$release_root/images.json"
echo '[]' >"$images_file"
revision=$(git rev-parse HEAD 2>/dev/null || echo unknown)
build_image() {
  local image_name=$1 dockerfile=$2
  local layout="$oci_root/$image_name"
  local archive="${image_name}_${version}_linux_multiarch.oci.tar"
  mkdir -p "$layout"
  docker buildx build \
    --builder "$release_builder" \
    --platform linux/amd64,linux/arm64 \
    --build-arg "VERSION=$version" \
    --build-arg "REVISION=$revision" \
    --file "$dockerfile" \
    --provenance=false \
    --output "type=oci,dest=$layout,tar=false" \
    .
  local reports='[]'
  for platform in linux/amd64 linux/arm64; do
    local suffix=${platform//\//_}
    local vulnerability="${image_name}_${version}_${suffix}.trivy.sarif"
    local sbom="${image_name}_${version}_${suffix}.cdx.json"
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
  local digest bytes index_digest
  digest=$(sha256sum "$output/$archive" | awk '{print $1}')
  bytes=$(stat -c '%s' "$output/$archive")
  index_digest=$(jq -er '.manifests[0].digest | select(test("^sha256:[a-f0-9]{64}$"))' "$layout/index.json")
  jq --arg name "$image_name" --arg archive "$archive" --arg sha256 "$digest" --arg indexDigest "$index_digest" \
    --argjson bytes "$bytes" --argjson reports "$reports" \
    '. + [{name:$name,archive:$archive,sha256:$sha256,indexDigest:$indexDigest,bytes:$bytes,platforms:["linux/amd64","linux/arm64"],reports:$reports}]' \
    "$images_file" >"$images_file.next"
  mv "$images_file.next" "$images_file"
}

build_image feedback-redmine-gateway apps/feedback-redmine-gateway-reference/Dockerfile
build_image feedback-redmine-demo apps/feedback-redmine-demo/Dockerfile

RELEASE_PACKAGE_VERSION="$version" node -e '
  const fs = require("node:fs");
  const rows = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map((line) => {
    const [name, filename, sha256] = line.split("\t");
    return { name, filename, sha256 };
  });
  const images = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  const manifest = {
    schemaVersion: "1",
    product: "feedback-redmine",
    version: process.env.RELEASE_PACKAGE_VERSION,
    publishOrder: rows.map(({ name }) => name),
    packages: rows,
    images,
    signingTargets: ["SHA256SUMS", "release-manifest.json"]
  };
  fs.writeFileSync(process.argv[2], `${JSON.stringify(manifest, null, 2)}\n`);
' "$artifacts_file" "$output/release-manifest.json" "$images_file"

(
  cd "$output"
  find . -maxdepth 1 -type f ! -name SHA256SUMS -printf '%P\n' | LC_ALL=C sort | xargs sha256sum >SHA256SUMS
  sha256sum --check SHA256SUMS >/dev/null
)

echo "[feedback-redmine-release] PASS: $output"
