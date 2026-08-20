#!/usr/bin/env bash
# Redmine gateway・SPA・公開package境界だけを検証する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"
[[ "${FEEDBACK_VERIFY_SKIP_COMMON_CONTRACTS:-0}" == "1" ]] || bash scripts/check-feedback-common-contracts.sh

fail() { echo "[feedback-redmine-contract] FAIL: $*" >&2; exit 1; }
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
npx --no-install openapi-typescript contracts/feedback/redmine-gateway.openapi.yaml -o "$tmp" >/dev/null
diff -u contracts/feedback/src/redmine-gateway.generated.ts "$tmp" || \
  fail "Redmine gateway生成型がOpenAPIと同期していません"
npx --no-install spectral lint --ruleset .spectral.yaml contracts/feedback/redmine-gateway.openapi.yaml

if rg -n '@web-gis|apps/api/openapi|app\.projects|app\.users|gis_data|org\.postgis|(^|[^A-Za-z0-9_])ST_[A-Za-z0-9_]+' \
    packages/feedback-redmine-core/src packages/feedback-redmine-react/src packages/feedback-redmine-plugin/src \
    packages/feedback-redmine-gateway/src apps/feedback-redmine-gateway-reference/src; then
  fail "Redmine標準構成にhost固有依存が混入しています"
fi

echo "[feedback-redmine-contract] PASS"
