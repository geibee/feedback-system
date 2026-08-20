#!/usr/bin/env bash
# Redmine標準構成とlegacy構成のcontainer platform境界をまとめて検証する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

bash scripts/check-feedback-redmine-container-platforms.sh
bash scripts/check-feedback-legacy-container-platforms.sh

echo "[feedback-container-platform] PASS: 全containerのplatform境界を確認しました"
