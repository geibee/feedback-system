#!/usr/bin/env bash
# Redmine標準構成とlegacy構成をまとめて実行する正規fail-closed品質ゲート。
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

FEEDBACK_VERIFY_SKIP_NPM_CI=1 bash scripts/verify-feedback-redmine.sh
FEEDBACK_VERIFY_SKIP_NPM_CI=1 \
FEEDBACK_VERIFY_SKIP_SHARED_PACKAGES=1 \
FEEDBACK_VERIFY_SKIP_COMMON_CONTRACTS=1 \
  bash scripts/verify-feedback-legacy.sh

echo "[feedback-verify] PASS"
