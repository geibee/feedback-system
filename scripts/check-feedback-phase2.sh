#!/usr/bin/env bash
# 汎用化Phase 2のcodec、fake、TCK、sanitized live fixture、freeze文書をfail-closedで検査する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

fail() { echo "[feedback-phase2] FAIL: $*" >&2; exit 1; }
for command in node npm rg jq; do command -v "$command" >/dev/null 2>&1 || fail "$command が見つかりません"; done

required_files=(
  contracts/feedback/schemas/feedback-attachment-marker.schema.json
  contracts/feedback/src/feedback-attachment-marker.generated.ts
  contracts/feedback/src/v2-openapi-contract.test.ts
  packages/feedback-client/src/testing.ts
  packages/feedback-connector-sdk/src/testing.ts
  packages/feedback-connector-redmine/src/contract-fixture.ts
  packages/feedback-connector-jira-cloud/src/contract-fixture.ts
  packages/feedback-envelope/src/index.ts
  tests/fixtures/jira-cloud-phase2/live-observations.json
  tests/fixtures/jira-cloud-phase2/issue-create-request.sanitized.json
  tests/fixtures/jira-cloud-phase2/issue-property-roundtrip.sanitized.json
  tests/fixtures/jira-cloud-phase2/comment-property-roundtrip.sanitized.json
  tests/fixtures/jira-cloud-phase2/attachment-roundtrip.sanitized.json
  tests/fixtures/jira-cloud-phase2/forge-app/manifest.yml
  docs/phase2/contract-freeze.md
  docs/phase2/jira-cloud-contract-spike.md
  docs/phase2/compatibility-test-plan.md
)
for file in "${required_files[@]}"; do [[ -f "$file" ]] || fail "必須fileがありません: $file"; done

while IFS= read -r -d '' fixture; do jq -e . "$fixture" >/dev/null; done \
  < <(find tests/fixtures/jira-cloud-phase2 -maxdepth 1 -type f -name '*.json' -print0)

node <<'NODE'
const { readFileSync } = require("node:fs");
const observation = JSON.parse(readFileSync("tests/fixtures/jira-cloud-phase2/live-observations.json", "utf8"));
if (observation.confirmedAt !== "2026-08-31" || observation.api !== "Jira Cloud REST API v3") {
  throw new Error("Jira Cloud live確認日またはAPIが不正です");
}
if (!observation.tenantIdentifiersRemoved || !observation.forge?.installed || observation.forge.storageModules !== 0 || observation.forge.connectModules !== 0) {
  throw new Error("Jira live fixtureのsanitize／Forge境界が不正です");
}
if (!observation.issue?.firstWriteStoredTriplet || observation.timeout?.clientResult !== "curl-28-no-response-bytes" || observation.timeout?.reissuedProviderWrite !== false || !observation.timeout?.recoveredTripletMatched) {
  throw new Error("first writeまたはtimeout回収のlive根拠がありません");
}
const guarantees = observation.guarantees;
const expected = { create: "recoverable", reply: "recoverable", revision: "best-effort", attachmentUpload: "best-effort" };
if (JSON.stringify(guarantees) !== JSON.stringify(expected)) throw new Error("Jira operation保証がfreeze値と不一致です");
if (observation.attachment?.uploadAttempts !== 1 || observation.attachment?.automaticRetry !== false) {
  throw new Error("attachment自動再送禁止が記録されていません");
}
NODE

for phrase in \
  'feedback-v2-contract-2.0.0-alpha.1' \
  '`recoverable` | `recoverable` | `best-effort` | `best-effort`' \
  '試行上限1、binary自動再送0' \
  'automaticWriteAllowed: false' \
  'Authorization Mode decision' \
  '複数hitは`repair_required`'; do
  rg -Fq "$phrase" docs/phase2/contract-freeze.md || fail "freeze判断がありません: $phrase"
done

matrix_rows=$(rg -c '^\| (v1-only ticket|v2 dual-write ticketのread|v1からdual-write ticketへreply／revision|v2からdual-write ticketへreply／revision|ticket作成後、Envelope前に失敗|Envelope後、projection前に失敗|projection後、attachment前に失敗|legacyとvalid v2が共存|legacyとinvalid v2が共存|v2停止／rollback) \|' docs/phase2/compatibility-test-plan.md)
[[ "$matrix_rows" == "10" ]] || fail "compatibility matrixの10行にtest計画がありません: actual=$matrix_rows"

if rg -n 'TODO|TBD|決定待ち|未決(事項|欄|項目)' docs/phase2; then
  fail "Contract freeze文書に未決表現があります"
fi

for forbidden in '^ *storage:' '^ *function:' 'connect:' 'jira:customUI' 'jira:issuePanel'; do
  if rg -n "$forbidden" tests/fixtures/jira-cloud-phase2/forge-app/manifest.yml; then
    fail "Forge index appへ禁止moduleが混入しています: $forbidden"
  fi
done
for indexed in threadId intentId requestHash; do
  rg -Fq "path: $indexed" tests/fixtures/jira-cloud-phase2/forge-app/manifest.yml \
    || fail "Forge entity property indexが不足しています: $indexed"
done

rg -Fq 'createPhase2RecoveryIssue' tests/redmine-conformance/src/run.mjs \
  || fail "Redmine first-write fixtureがありません"
rg -Fq 'verifyPhase2RecoveryIssue' tests/redmine-conformance/src/run.mjs \
  || fail "Redmine別process回収fixtureがありません"

packages=(
  @geibee/feedback-contracts
  @geibee/feedback-envelope
  @geibee/feedback-client
  @geibee/feedback-connector-sdk
  @geibee/feedback-gateway
  @geibee/feedback-controller
  @geibee/feedback-connector-redmine
  @geibee/feedback-connector-jira-cloud
)
for package_name in "${packages[@]}"; do
  echo "[feedback-phase2-package] $package_name"
  npm --workspace "$package_name" run typecheck
  npm --workspace "$package_name" run test
done

# Redmine conformanceは公開packageのdist型をNodeNextで解決するため、clean checkoutでも
# 前段Phaseの未追跡build出力に依存しない順序で必要な型を生成する。
npm --workspace @geibee/feedback-core run build
npm --workspace @geibee/feedback-redmine-core run build
npm --workspace @geibee/feedback-redmine-gateway run build
npm --workspace @geibee/redmine-conformance run typecheck

echo "[feedback-phase2] PASS"
