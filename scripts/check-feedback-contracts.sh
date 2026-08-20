#!/usr/bin/env bash
# 共通・Redmine・legacy契約をまとめて検証するrelease用入口。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

bash scripts/check-feedback-common-contracts.sh
FEEDBACK_VERIFY_SKIP_COMMON_CONTRACTS=1 bash scripts/check-feedback-redmine-contracts.sh
FEEDBACK_VERIFY_SKIP_COMMON_CONTRACTS=1 bash scripts/check-feedback-legacy-contracts.sh

echo "[feedback-contract] PASS: 共通・Redmine・legacy契約は同期しています"
