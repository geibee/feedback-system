#!/usr/bin/env bash
# Redmine正本clientのworkspaceを依存順に検証する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

packages=(
  @geibee/dom-capture
  @geibee/react-ui
  @geibee/maplibre
  @geibee/redmine-core
  @geibee/redmine-react
  @geibee/redmine-plugin
  @geibee/redmine-gateway
  @geibee/redmine-ops
  @geibee/redmine-gateway-reference
  @geibee/redmine-demo
  feedback-redmine-plugin-vanilla-fixture
  @geibee/redmine-browser-e2e
  @geibee/redmine-conformance
)

for package_name in "${packages[@]}"; do
  echo "[feedback-redmine-package] $package_name"
  npm --workspace "$package_name" run typecheck
  npm --workspace "$package_name" run test
  npm --workspace "$package_name" run build
done

bash scripts/check-feedback-redmine-tarball-consumer.sh

echo "[feedback-redmine-package] PASS"
