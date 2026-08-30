#!/usr/bin/env bash
# Redmine契約を検証するrelease用入口。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

bash scripts/check-feedback-common-contracts.sh
FEEDBACK_VERIFY_SKIP_COMMON_CONTRACTS=1 bash scripts/check-feedback-redmine-contracts.sh
echo "[feedback-contract] PASS: Redmine契約は同期しています"
