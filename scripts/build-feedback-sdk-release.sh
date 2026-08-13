#!/usr/bin/env bash
# private workspaceからregistry投入可能なFeedback SDK tarball一式を再現可能に生成する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

output=""
version=${FEEDBACK_RELEASE_VERSION:-}

usage() {
  echo "usage: scripts/build-feedback-sdk-release.sh --output <empty-directory> --version <semver>" >&2
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
for command in node npm tar sha256sum; do
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

release_root=$(mktemp -d -t feedback-sdk-release.XXXXXX)
cleanup() {
  if [[ -d "$release_root" && "$(basename "$release_root")" == feedback-sdk-release.?????? ]]; then
    rm -rf -- "$release_root"
  fi
}
trap cleanup EXIT

packages=(
  @feedback/contracts
  @feedback/core
  @feedback/react
  @feedback/maplibre
  @feedback/admin-react
)

npm run build:packages

artifacts_file="$release_root/artifacts.tsv"
: >"$artifacts_file"
for package_name in "${packages[@]}"; do
  package_key=${package_name#@feedback/}
  source_dir="$release_root/source-$package_key"
  stage_dir="$release_root/stage-$package_key"
  mkdir -p "$source_dir" "$stage_dir"

  source_result=$(npm --workspace "$package_name" pack --pack-destination "$source_dir" --json)
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
    value.publishConfig = { ...(value.publishConfig || {}), access: "restricted" };
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const name of Object.keys(value[section] || {})) {
        if (name.startsWith("@feedback/")) value[section][name] = process.env.RELEASE_PACKAGE_VERSION;
      }
    }
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  ' "$stage_dir/package.json"

  release_result=$(npm pack "$stage_dir" --pack-destination "$output" --json)
  release_tarball=$(PACK_RESULT="$release_result" node -e '
    const [result] = JSON.parse(process.env.PACK_RESULT);
    process.stdout.write(result.filename);
  ')
  tar -xOf "$output/$release_tarball" package/package.json | \
    EXPECTED_NAME="$package_name" EXPECTED_VERSION="$version" node -e '
      const fs = require("node:fs");
      const value = JSON.parse(fs.readFileSync(0, "utf8"));
      if (value.name !== process.env.EXPECTED_NAME || value.version !== process.env.EXPECTED_VERSION ||
          value.private === true || value.publishConfig?.access !== "restricted") process.exit(1);
    '
  digest=$(sha256sum "$output/$release_tarball" | awk '{print $1}')
  printf '%s\t%s\t%s\n' "$package_name" "$release_tarball" "$digest" >>"$artifacts_file"
done

RELEASE_PACKAGE_VERSION="$version" node -e '
  const fs = require("node:fs");
  const rows = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map((line) => {
    const [name, filename, sha256] = line.split("\t");
    return { name, filename, sha256 };
  });
  const manifest = {
    schemaVersion: "1",
    product: "feedback-sdk",
    version: process.env.RELEASE_PACKAGE_VERSION,
    publishOrder: rows.map(({ name }) => name),
    packages: rows
  };
  fs.writeFileSync(process.argv[2], `${JSON.stringify(manifest, null, 2)}\n`);
' "$artifacts_file" "$output/release-manifest.json"

(
  cd "$output"
  find . -maxdepth 1 -type f ! -name SHA256SUMS -printf '%P\n' | LC_ALL=C sort | xargs sha256sum >SHA256SUMS
  sha256sum --check SHA256SUMS >/dev/null
)

echo "[feedback-sdk-release] PASS: $output"
