#!/usr/bin/env bash
# Azure本番配備用Bicepとsecurity invariantをfail-closedで検証する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

log() { echo "[feedback-azure-verify] $*"; }
fail() { echo "[feedback-azure-verify] FAIL: $*" >&2; exit 1; }

command -v az >/dev/null 2>&1 || fail "Azure CLIが見つかりません"
command -v rg >/dev/null 2>&1 || fail "ripgrepが見つかりません"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export DOTNET_BUNDLE_EXTRACT_BASE_DIR="$tmp/bicep-bundle"

az bicep version >/dev/null 2>&1 || fail "Bicep CLIが見つかりません (az bicep installを実行してください)"
for template in deploy/azure/main.bicep deploy/azure/front-door.bicep; do
  log "$template"
  az bicep build --file "$template" --stdout >"$tmp/$(basename "$template").json"
done

rg -q "allowSharedKeyAccess: false" deploy/azure/main.bicep || fail "Storage Shared Keyが無効化されていません"
rg -q "allowBlobPublicAccess: false" deploy/azure/main.bicep || fail "Blob公開が無効化されていません"
[[ "$(rg -c "publicNetworkAccess: 'Disabled'" deploy/azure/main.bicep)" -ge 3 ]] || \
  fail "PostgreSQL、Storage、Key Vaultのpublic access無効化が不足しています"
rg -q "groupId: 'managedEnvironments'" deploy/azure/front-door.bicep || \
  fail "Front DoorからContainer AppsへのPrivate Linkがありません"
rg -q "'/feedback/v1/\*'" deploy/azure/front-door.bicep || fail "Feedback API routeがありません"
rg -q "param runtimeEnabled bool = false" deploy/azure/main.bicep || \
  fail "migration前にruntimeを停止する既定値がありません"

log "PASS"
