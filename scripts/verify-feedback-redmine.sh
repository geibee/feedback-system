#!/usr/bin/env bash
# Redmine正本SPA・gatewayだけを検証する標準品質ゲート。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

log() { echo "[feedback-redmine-verify] $*"; }
fail() { echo "[feedback-redmine-verify] FAIL: $*" >&2; exit 1; }
for command in node npm docker; do command -v "$command" >/dev/null 2>&1 || fail "$command が見つかりません"; done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2が見つかりません"

node_supported=$(node -p '
  const [major, minor] = process.versions.node.split(".").map(Number);
  String((major === 22 && minor >= 12) || major === 23 || major === 24);
')
[[ "$node_supported" == "true" ]] || fail "Node.js 22.12以上25未満が必要です"
bash -n scripts/build-feedback-redmine-release.sh
bash -n scripts/publish-feedback-redmine-release.sh
bash -n scripts/smoke-feedback-redmine.sh

if [[ "${FEEDBACK_VERIFY_SKIP_NPM_CI:-0}" != "1" ]]; then
  log "clean npm install"
  npm ci --ignore-scripts --no-audit --no-fund
fi

for package_name in @geibee/feedback-contracts @geibee/feedback-core; do
  log "$package_name"
  npm --workspace "$package_name" run typecheck
  npm --workspace "$package_name" run test
  npm --workspace "$package_name" run build
done

bash scripts/check-feedback-redmine-packages.sh
bash scripts/check-feedback-redmine-ops.sh
bash scripts/check-feedback-redmine-contracts.sh
bash scripts/check-feedback-redmine-security.sh
bash scripts/check-feedback-redmine-conformance.sh
bash scripts/check-feedback-redmine-release.sh
bash scripts/check-feedback-redmine-publish.sh
bash scripts/check-feedback-redmine-container-platforms.sh

log "PASS"
