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
feedback_npm_cache="$consumer_tmp/npm-cache"
vite_version=8.2.1
mkdir -p "$tarball_dir" "$feedback_npm_cache"
packages=(
  @geibee/contracts
  @geibee/core
  @geibee/dom-capture
  @geibee/react-ui
  @geibee/redmine-core
  @geibee/redmine-react
  @geibee/redmine-plugin
)
declare -a tarballs=()

for package_name in "${packages[@]}"; do
  pack_result=$(npm_config_cache="$feedback_npm_cache" npm --workspace "$package_name" pack --pack-destination "$tarball_dir" --json)
  tarball_file=$(PACK_RESULT="$pack_result" PACKAGE_NAME="$package_name" node -e '
    const [result] = JSON.parse(process.env.PACK_RESULT);
    const files = new Set(result.files.map((file) => file.path));
    const required = ["dist/index.js", "dist/index.d.ts", "package.json", "README.md"];
    if (process.env.PACKAGE_NAME === "@geibee/contracts") {
      required.push(
        "redmine-gateway.openapi.yaml",
        "schemas/redmine-model.schema.json",
        "dist/redmine-gateway.generated.js",
        "dist/redmine-gateway.generated.d.ts"
      );
    }
    if (process.env.PACKAGE_NAME === "@geibee/redmine-core") {
      required.push("dist/trusted.js", "dist/trusted.d.ts");
    }
    if (process.env.PACKAGE_NAME === "@geibee/redmine-react") required.push("dist/styles.css");
    if (process.env.PACKAGE_NAME === "@geibee/redmine-plugin") {
      required.push("dist/loader.js", "dist/loader.d.ts");
      if (files.has("dist/feedback-redmine-plugin-with-react.es.js")) process.exit(1);
    }
    if (required.some((path) => !files.has(path))) process.exit(1);
    process.stdout.write(result.filename);
  ') || {
    echo "[feedback-redmine-consumer] FAIL: $package_name tarballの公開fileが不足しています" >&2
    exit 1
  }
  tarballs+=("$tarball_dir/$tarball_file")
done

react_versions=(18.3.1 19.1.1)
react_type_versions=(18.3.12 19.1.9)
react_dom_type_versions=(18.3.1 19.1.7)
typescript_versions=(5.6.3 5.9.3)

for index in "${!react_versions[@]}"; do
  react_version=${react_versions[$index]}
  fixture="$consumer_tmp/react-$react_version"
  cp -R tests/fixtures/feedback-redmine-plugin-vanilla "$fixture"
  rm -rf -- "$fixture/dist"
  (
    cd "$fixture"
    npm_config_cache="$feedback_npm_cache" npm install --ignore-scripts --no-audit --no-fund \
      "react@$react_version" "react-dom@$react_version" \
      "@types/react@${react_type_versions[$index]}" "@types/react-dom@${react_dom_type_versions[$index]}" \
      "typescript@${typescript_versions[$index]}" "vite@$vite_version" vitest@4.1.9 jsdom@29.1.1 \
      "${tarballs[@]}"
    npm ls react react-dom --all >/dev/null
    test ! -d node_modules/@geibee/react
    npm run typecheck
    npm run test
    npm run build
    node --input-type=module -e 'await import("@geibee/redmine-plugin/loader")'
    test -f node_modules/@geibee/redmine-react/dist/styles.css
    test -f node_modules/@geibee/redmine-core/dist/trusted.js
  )
  echo "[feedback-redmine-consumer] PASS: clean Vite $vite_version / React $react_version fixture"
done
