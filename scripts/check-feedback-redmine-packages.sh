#!/usr/bin/env bash
# Redmine正本clientのworkspaceを依存順に検証する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

packages=(
  @feedback/dom-capture
  @feedback/react-ui
  @feedback/maplibre
  @feedback/redmine-core
  @feedback/redmine-react
  @feedback/redmine-plugin
  @feedback/redmine-gateway
  @feedback/redmine-ops
  @feedback/redmine-gateway-reference
  @feedback/redmine-demo
  feedback-redmine-plugin-vanilla-fixture
  @feedback/redmine-browser-e2e
  @feedback/redmine-conformance
)

for package_name in "${packages[@]}"; do
  echo "[feedback-redmine-package] $package_name"
  npm --workspace "$package_name" run typecheck
  npm --workspace "$package_name" run test
  npm --workspace "$package_name" run build
done

bash scripts/check-feedback-redmine-tarball-consumer.sh

echo "[feedback-redmine-package] PASS"
