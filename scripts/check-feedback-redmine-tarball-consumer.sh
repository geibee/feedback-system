#!/usr/bin/env bash
# Redmine browser packageの実tarballをworkspace外のvanilla Vite fixtureへ導入する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

consumer_tmp=$(mktemp -d -t feedback-redmine-consumer.XXXXXX)
cleanup_consumer() {
  if [[ -d "$consumer_tmp" && "$(basename "$consumer_tmp")" == feedback-redmine-consumer.* ]]; then
    rm -rf -- "$consumer_tmp"
  fi
}
trap cleanup_consumer EXIT

tarball_dir="$consumer_tmp/tarballs"
mkdir -p "$tarball_dir"
packages=(
  @feedback/contracts
  @feedback/core
  @feedback/react
  @feedback/redmine-core
  @feedback/redmine-react
  @feedback/redmine-plugin
)
declare -a tarballs=()

for package_name in "${packages[@]}"; do
  pack_result=$(npm --workspace "$package_name" pack --pack-destination "$tarball_dir" --json)
  tarball_file=$(PACK_RESULT="$pack_result" PACKAGE_NAME="$package_name" node -e '
    const [result] = JSON.parse(process.env.PACK_RESULT);
    const files = new Set(result.files.map((file) => file.path));
    const required = ["dist/index.js", "dist/index.d.ts", "package.json", "README.md"];
    if (process.env.PACKAGE_NAME === "@feedback/contracts") {
      required.push(
        "redmine-gateway.openapi.yaml",
        "schemas/redmine-model.schema.json",
        "schemas/redmine-operation.schema.json",
        "dist/redmine-gateway.generated.js",
        "dist/redmine-gateway.generated.d.ts"
      );
    }
    if (process.env.PACKAGE_NAME === "@feedback/redmine-core") {
      required.push("dist/trusted.js", "dist/trusted.d.ts");
    }
    if (process.env.PACKAGE_NAME === "@feedback/redmine-react") required.push("dist/styles.css");
    if (process.env.PACKAGE_NAME === "@feedback/redmine-plugin") {
      required.push("dist/feedback-redmine-plugin-with-react.es.js");
    }
    if (required.some((path) => !files.has(path))) process.exit(1);
    process.stdout.write(result.filename);
  ') || {
    echo "[feedback-redmine-consumer] FAIL: $package_name tarballの公開fileが不足しています" >&2
    exit 1
  }
  tarballs+=("$tarball_dir/$tarball_file")
done

fixture="$consumer_tmp/fixture"
cp -R tests/fixtures/feedback-redmine-plugin-vanilla "$fixture"
rm -rf -- "$fixture/dist"
(
  cd "$fixture"
  npm install --ignore-scripts --no-audit --no-fund \
    react@18.3.1 react-dom@18.3.1 @types/react@18.3.12 @types/react-dom@18.3.1 \
    typescript@5.6.3 vite@5.4.21 vitest@4.1.9 jsdom@29.1.1 \
    "${tarballs[@]}"
  npm run typecheck
  npm run test
  npm run build
  node --input-type=module -e 'await import("@feedback/redmine-plugin")'
  test -f node_modules/@feedback/redmine-react/dist/styles.css
  test -f node_modules/@feedback/redmine-core/dist/trusted.js
)

echo "[feedback-redmine-consumer] PASS: clean vanilla Vite tarball consumer"
