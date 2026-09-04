#!/usr/bin/env bash
# 汎用化Phase 5のproduction composition、compatibility、fault、運用、live evidenceをfail-closedで検査する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

fail() { echo "[feedback-phase5] FAIL: $*" >&2; exit 1; }
for command in node npm rg jq sha256sum docker; do command -v "$command" >/dev/null 2>&1 || fail "$command が見つかりません"; done
docker buildx version >/dev/null 2>&1 || fail "Docker Buildxが見つかりません"

required_files=(
  apps/feedback-service-runtime/src/composition.ts
  apps/feedback-service-runtime/src/connector-registry.ts
  apps/feedback-service-runtime/src/projection.ts
  apps/feedback-service-runtime/src/listener.ts
  apps/feedback-service-runtime/Dockerfile
  tests/feedback-provider-acceptance/src/renderers.test.tsx
  tests/feedback-provider-acceptance/src/service-client-jira.test.ts
  scripts/run-feedback-jira-live-acceptance.mjs
  scripts/check-feedback-phase5-live.sh
  tests/fixtures/jira-cloud-phase5/live-acceptance.json
  tests/fixtures/jira-cloud-phase5/forge-deployment.json
  packages/feedback-connector-backlog/src/connector.ts
  packages/feedback-connector-backlog/src/contract-fixture.ts
  scripts/run-feedback-backlog-live-conformance.mjs
  scripts/check-feedback-backlog-live.sh
  scripts/build-feedback-service-release.sh
  scripts/check-feedback-service-release.sh
  scripts/check-feedback-service-publish.sh
  scripts/publish-feedback-service-release.sh
  tests/fixtures/backlog-stage-a/live-gate.json
  tests/fixtures/backlog-stage-b/live-conformance.json
  docs/phase5/compatibility-matrix.md
  docs/phase5/deployment.md
  docs/phase5/storage-migration.md
  docs/phase5/key-rotation.md
  docs/phase5/incident-runbook.md
  docs/phase5/rollback.md
  docs/phase5/phase5-gate.md
  docs/phase5/contract-freeze.sha256
)
for file in "${required_files[@]}"; do [[ -f "$file" ]] || fail "必須fileがありません: $file"; done
for script in scripts/build-feedback-service-release.sh scripts/check-feedback-service-release.sh \
  scripts/check-feedback-service-publish.sh \
  scripts/publish-feedback-service-release.sh scripts/check-feedback-backlog-live.sh; do
  bash -n "$script" || fail "release scriptの構文が不正です: $script"
done

phase5_plan=$(sed -n '/^### Phase 5:/,/^### 後続Connector追加計画/p' feedback-system-generalization-plan.md | sed '$d')
if rg -n -- '- \[ \]' <<<"$phase5_plan"; then fail "Phase 5 checklistに未完了項目があります"; fi
if rg -n 'TODO|TBD|決定待ち|未決(事項|欄|項目)' docs/phase5; then fail "Phase 5文書に未決表現があります"; fi
sha256sum -c docs/phase5/contract-freeze.sha256

matrix_rows=$(rg -c '^\| (v1-only ticket|v2 dual-write ticketのread|v1からdual-write ticketへreply／revision|v2からdual-write ticketへreply／revision|ticket作成後、Envelope前に失敗|Envelope後、projection前に失敗|projection後、attachment前に失敗|legacyとvalid v2が共存|legacyとinvalid v2が共存|v2停止／rollback) \|' docs/phase5/compatibility-matrix.md)
[[ "$matrix_rows" == "10" ]] || fail "Phase 5 compatibility matrixが10行ではありません: $matrix_rows"

jq -e '
  .schemaVersion == "1" and
  .kind == "jira-cloud-phase5-live-acceptance" and
  .contractVersion == "2.0.0-alpha.2" and
  (.implementationDigest | test("^sha256:[a-f0-9]{64}$")) and
  .api == "Jira Cloud REST API v3" and
  .siteType == "Forge development demo" and
  .tenantIdentifiersRemoved == true and
  .runOwnedIssueCreated == true and
  .firstWriteTripletRecovered == true and
  .commentRoundtrip == true and
  .revisionRoundtrip == true and
  .bodyIntegrityVerified == true and
  .attachmentRoundtrip == true and
  .attachmentMessageBindingVerified == true and
  .automaticWriteRetry == false and
  .cleanup == "deleted-run-owned-issue" and
  (.executedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$"))
' tests/fixtures/jira-cloud-phase5/live-acceptance.json >/dev/null || fail "Jira Cloud Phase 5 live evidenceが不正です"

current_live_digest=$(node -e '
  const { createHash } = require("node:crypto");
  const { readFileSync } = require("node:fs");
  const files = [
    "contracts/feedback/feedback-gateway.openapi.yaml",
    "contracts/feedback/schemas/feedback-attachment-marker.schema.json",
    "packages/feedback-connector-jira-cloud/src/connector.ts",
    "packages/feedback-connector-jira-cloud/src/rest-v3-client.ts",
    "packages/feedback-connector-jira-cloud/src/types.ts",
    "scripts/run-feedback-jira-live-acceptance.mjs"
  ];
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(readFileSync(file)).update("\0");
  process.stdout.write("sha256:" + hash.digest("hex"));
')
[[ "$(jq -r .implementationDigest tests/fixtures/jira-cloud-phase5/live-acceptance.json)" == "$current_live_digest" ]] \
  || fail "保存済みJira live evidenceが現acceptance実装へbindingされていません。scripts/check-feedback-phase5-live.shを再実行してください"

jq -e '
  .schemaVersion == "1" and
  .kind == "backlog-stage-b-live-conformance" and
  .contractVersion == "2.0.0-alpha.2" and
  (.implementationDigest | test("^sha256:[a-f0-9]{64}$")) and
  .api == "Backlog API v2" and
  .siteType == "Backlog SaaS free trial" and
  .tenantIdentifiersRemoved == true and
  (.provisioning | [.[]] | all) and
  (.capabilities | [.[]] | all) and
  .recovery.zeroCreateHitPending == true and
  .recovery.createResponseLostAfterCommit == true and
  .recovery.createRecoveredFromProvider == true and
  .recovery.replyResponseLostAfterCommit == true and
  .recovery.replyRecoveredFromProvider == true and
  .recovery.revisionResponseLostAfterCommit == true and
  .recovery.revisionRecoveredFromProvider == true and
  .recovery.duplicateThreadRepairRequired == true and
  .recovery.automaticWriteRetry == false and
  (.roundtrip | [.[]] | all) and
  .restartReconstruction.separateProcess == true and
  .restartReconstruction.providerObjectIdentifiersPassed == false and
  .restartReconstruction.threadRecovered == true and
  .restartReconstruction.intentsRecovered == true and
  .restartReconstruction.resourceProjectionRecovered == true and
  .cleanup == "deleted-all-run-owned-issues"
' tests/fixtures/backlog-stage-b/live-conformance.json >/dev/null || fail "Backlog Stage B live evidenceが不正です"

current_backlog_live_digest=$(node -e '
  const { createHash } = require("node:crypto");
  const { readFileSync } = require("node:fs");
  const files = [
    "packages/feedback-connector-backlog/src/connector.ts",
    "packages/feedback-connector-backlog/src/http-transport.ts",
    "packages/feedback-connector-backlog/src/provisioning.ts",
    "packages/feedback-connector-backlog/src/rest-v2-client.ts",
    "packages/feedback-connector-backlog/src/types.ts",
    "scripts/run-feedback-backlog-live-conformance.mjs"
  ];
  const digest = createHash("sha256");
  for (const file of files) digest.update(file).update("\0").update(readFileSync(file)).update("\0");
  process.stdout.write("sha256:" + digest.digest("hex"));
')
[[ "$(jq -r .implementationDigest tests/fixtures/backlog-stage-b/live-conformance.json)" == "$current_backlog_live_digest" ]] \
  || fail "保存済みBacklog Stage B live evidenceが現Connector実装へbindingされていません。scripts/check-feedback-backlog-live.shを再実行してください"

jq -e '
  .schemaVersion == "1" and
  .kind == "jira-cloud-phase5-forge-deployment" and
  .environment == "development" and
  .siteType == "Forge development demo" and
  .deployed == true and .installed == true and
  .module == "jira:entityProperty" and
  .storageModules == 0 and .connectModules == 0 and
  .tenantIdentifiersRemoved == true
' tests/fixtures/jira-cloud-phase5/forge-deployment.json >/dev/null || fail "Forge Phase 5 deploy evidenceが不正です"

node <<'NODE'
const { readFileSync } = require("node:fs");
const service = JSON.parse(readFileSync("apps/feedback-service/package.json", "utf8"));
const runtime = JSON.parse(readFileSync("apps/feedback-service-runtime/package.json", "utf8"));
const releaseVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
const serviceDependencies = Object.keys({ ...(service.dependencies || {}), ...(service.optionalDependencies || {}) });
if (serviceDependencies.some((name) => /connector-(?:jira-cloud|redmine)|forge/u.test(name))) {
  throw new Error("provider非依存Feedback Serviceへproduction Connectorが混入しています");
}
for (const required of ["@geibee/feedback-service", "@geibee/feedback-connector-jira-cloud", "@geibee/feedback-connector-redmine", "@geibee/feedback-connector-backlog"]) {
  if (runtime.dependencies?.[required] !== releaseVersion) throw new Error(`runtime composition dependencyがrelease versionと一致しません: ${required}`);
}
const forbidden = /(prisma|sequelize|typeorm|mongoose|postgres|mysql|sqlite|redis|bull|queue|kafka|amqp|rabbit|memcached|cache|storage|s3|r2|blob|forge)/iu;
for (const dependency of Object.keys(runtime.dependencies || {})) {
  if (forbidden.test(dependency)) throw new Error(`runtimeへ禁止dependencyが混入しています: ${dependency}`);
}
NODE

for integration_symbol in \
  createFeedbackHttpClient \
  createFeedbackService \
  createFeedbackJiraCloudConnector \
  createProductionFeedbackProjectionVerifier; do
  rg -Fq "$integration_symbol" tests/feedback-provider-acceptance/src/service-client-jira.test.ts \
    || fail "actual integration acceptanceが不足しています: $integration_symbol"
done

if rg -n "from ['\"](?:node:sqlite|pg|mysql|redis|bull|kafkajs|amqplib)|writeFile|mkdir|createWriteStream|uploadDirectory|@forge|forge-app" \
  apps/feedback-service-runtime/src --glob '!*.test.ts'; then
  fail "production runtimeへ永続化、upload storage、Forge実装が混入しています"
fi
if rg -n "feedback-connector-(?:jira-cloud|redmine|backlog)|@forge|forge-app" apps/feedback-service/src; then
  fail "provider非依存Feedback ServiceへConnector／Forge実装が混入しています"
fi
if rg -ni '\bbacklog\b' \
  apps/feedback-service/src packages/feedback-gateway/src packages/feedback-client/src \
  packages/feedback-controller/src packages/feedback-react/src packages/feedback-web-component/src \
  --glob '!*.test.ts'; then
  fail "provider非依存共通層またはUIへBacklog分岐が混入しています"
fi
if rg -n "from ['\"](?:node:sqlite|pg|mysql|redis|bull|kafkajs|amqplib)|writeFile|mkdir|createWriteStream|uploadDirectory" \
  packages/feedback-connector-backlog/src --glob '!*.test.ts'; then
  fail "Backlog Connectorへ補助storage実装が混入しています"
fi
for field in threadId intentId requestHash; do
  rg -Fq "path: $field" packages/feedback-connector-jira-cloud/forge-app/manifest.yml || fail "Forge index fieldがありません: $field"
done
for forbidden_module in storage function connect jira:customUI jira:issuePanel; do
  if rg -n "^[[:space:]]*$forbidden_module:" packages/feedback-connector-jira-cloud/forge-app/manifest.yml; then
    fail "Forge index artifactへ禁止moduleが混入しています: $forbidden_module"
  fi
done
if rg -n '^COPY --from=build .* /workspace /app$|forge-app' apps/feedback-service-runtime/Dockerfile; then
  fail "Feedback Service runtime最終imageへworkspace全体またはForge artifactを同梱しています"
fi
rg -Fq '/workspace/apps/feedback-service-runtime/dist /app/apps/feedback-service-runtime/dist' apps/feedback-service-runtime/Dockerfile \
  || fail "Feedback Service runtimeの最小dist copy境界がありません"

bash scripts/check-feedback-common-contracts.sh
docker buildx build --check -f apps/feedback-service-runtime/Dockerfile .

packages=(
  @geibee/feedback-gateway
  @geibee/feedback-service
  @geibee/feedback-connector-redmine
  @geibee/feedback-connector-jira-cloud
  @geibee/feedback-connector-backlog
  @geibee/feedback-controller
  @geibee/feedback-react
  @geibee/feedback-web-component
  @geibee/feedback-service-runtime
  @geibee/feedback-provider-acceptance
)
for package_name in "${packages[@]}"; do
  echo "[feedback-phase5-package] $package_name"
  npm --workspace "$package_name" run typecheck
  npm --workspace "$package_name" run test
  if [[ "$package_name" != "@geibee/feedback-provider-acceptance" ]]; then
    npm --workspace "$package_name" run build
  fi
done

echo "[feedback-phase5] PASS"
