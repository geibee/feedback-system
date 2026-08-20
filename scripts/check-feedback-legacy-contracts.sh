#!/usr/bin/env bash
# legacy Feedback Service・SDKに固有の契約境界を検証する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"
[[ "${FEEDBACK_VERIFY_SKIP_COMMON_CONTRACTS:-0}" == "1" ]] || bash scripts/check-feedback-common-contracts.sh

fail() { echo "[feedback-legacy-contract] FAIL: $*" >&2; exit 1; }
[[ -f apps/feedback-service-go/migrations/legacyjournal/V1__feedback_v4_copy_journal.sql ]] || \
  fail "Go legacy migration journalがありません"
npx --no-install spectral lint --ruleset .spectral.yaml contracts/feedback/token-exchange.openapi.yaml

if rg -n '@web-gis|apps/api/openapi' \
    packages/feedback-react/src packages/feedback-maplibre/src packages/feedback-admin-react/src \
    apps/feedback-admin/src apps/feedback-conformance-consumer/src; then
  fail "legacy独立packageにWeb GIS固有契約が混入しています"
fi
if rg -n 'projectId' contracts/feedback/src/generated.ts packages/feedback-core/src packages/feedback-react/src \
    packages/feedback-maplibre/src packages/feedback-admin-react/src apps/feedback-admin/src apps/feedback-conformance-consumer/src; then
  fail "legacy独立packageにWeb GIS projectIdが混入しています"
fi
if rg -n '@web-gis|apps/api/openapi|projectId|app\.projects|app\.users|gis_data|org\.postgis|(^|[^A-Za-z0-9_])ST_[A-Za-z0-9_]+' \
    apps/feedback-service-go; then
  fail "Feedback ServiceにWeb GIS/PostGIS固有依存が混入しています"
fi
if rg -n 'maplibre' packages/feedback-react/package.json packages/feedback-react/src; then
  fail "@geibee/reactがMapLibreへ依存しています"
fi
if rg -n 'style=|dangerouslySetInnerHTML|document\.head|<style' \
    packages/feedback-react/src packages/feedback-admin-react/src packages/feedback-maplibre/src; then
  fail "legacy packageにstrict CSPを壊すstyle注入が混入しています"
fi

echo "[feedback-legacy-contract] PASS"
