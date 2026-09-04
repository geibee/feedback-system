#!/usr/bin/env bash
# Redmine標準構成を実行する正規fail-closed品質ゲート。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

fail() { echo "[feedback-verify] FAIL: $*" >&2; exit 1; }
command -v node >/dev/null 2>&1 || fail "Node.jsが見つかりません"
command -v npm >/dev/null 2>&1 || fail "npmが見つかりません"

if [[ "${FEEDBACK_VERIFY_SKIP_NPM_CI:-0}" != "1" ]]; then
  echo "[feedback-verify] clean npm install"
  npm ci --ignore-scripts --no-audit --no-fund
fi

bash scripts/check-feedback-phase0.sh
bash scripts/check-feedback-phase1.sh
bash scripts/check-feedback-phase2.sh
bash scripts/check-feedback-phase3.sh
bash scripts/check-feedback-phase4.sh
FEEDBACK_VERIFY_SKIP_NPM_CI=1 bash scripts/verify-feedback-redmine.sh
bash scripts/check-feedback-phase5.sh
bash scripts/check-feedback-service-publish.sh
bash scripts/check-feedback-service-release.sh

echo "[feedback-verify] PASS"
