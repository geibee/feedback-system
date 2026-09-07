#!/usr/bin/env bash
# 汎用化Phase 3の4実装laneと独立Forge artifactをfail-closedで検査する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

fail() { echo "[feedback-phase3] FAIL: $*" >&2; exit 1; }
for command in node npm rg cmp; do command -v "$command" >/dev/null 2>&1 || fail "$command が見つかりません"; done

required_files=(
  packages/feedback-gateway/src/application.ts
  apps/feedback-service/src/authorization.ts
  apps/feedback-service/src/configuration.ts
  apps/feedback-service/src/http.ts
  apps/feedback-service/src/participant.ts
  packages/feedback-connector-redmine/src/connector.ts
  packages/feedback-connector-redmine/src/rest-transport.ts
  packages/feedback-connector-redmine/ops/feedback_redmine_v2_custom_fields.rb
  packages/feedback-connector-jira-cloud/src/connector.ts
  packages/feedback-connector-jira-cloud/src/http-transport.ts
  packages/feedback-connector-jira-cloud/forge-app/manifest.yml
  packages/feedback-client/src/http.ts
  packages/feedback-controller/src/controller.ts
  packages/feedback-controller/src/state.ts
  docs/phase3/phase3-gate.md
)
for file in "${required_files[@]}"; do [[ -f "$file" ]] || fail "必須fileがありません: $file"; done

phase3_plan=$(sed -n '/^### Phase 3:/,/^### Phase 4:/p' feedback-system-generalization-plan.md)
if rg -n -- '- \[ \]' <<<"$phase3_plan"; then
  fail "Phase 3 checklistに未完了項目があります"
fi
if rg -n 'TODO|TBD|決定待ち|未決(事項|欄|項目)' docs/phase3; then
  fail "Phase 3 Gate文書に未決表現があります"
fi
rg -Fq 'feedback-v2-contract-2.0.0-alpha.1' docs/phase3/phase3-gate.md \
  || fail "Contract freeze識別子がありません"

forge_manifest=packages/feedback-connector-jira-cloud/forge-app/manifest.yml
cmp -s "$forge_manifest" tests/fixtures/jira-cloud-phase2/forge-app/manifest.yml \
  || fail "Phase 3 Forge artifactがPhase 2 live確認manifestと一致しません"
for indexed in threadId intentId requestHash; do
  rg -Fq "path: $indexed" "$forge_manifest" || fail "Forge indexが不足しています: $indexed"
done
for forbidden in storage function connect jira:customUI jira:issuePanel; do
  if rg -n "^[[:space:]]*$forbidden:" "$forge_manifest"; then
    fail "Forge index artifactへ禁止moduleが混入しています: $forbidden"
  fi
done

node <<'NODE'
const { readFileSync } = require("node:fs");
const service = JSON.parse(readFileSync("apps/feedback-service/package.json", "utf8"));
const dependencies = Object.keys({
  ...(service.dependencies || {}),
  ...(service.optionalDependencies || {})
});
const forbidden = /(prisma|sequelize|typeorm|mongoose|postgres|mysql|sqlite|redis|bull|queue|kafka|amqp|rabbit|memcached|cache|storage|s3|r2|blob|forge|jira-cloud|redmine)/iu;
for (const dependency of dependencies) {
  if (forbidden.test(dependency)) throw new Error(`Feedback Serviceへ禁止dependencyが混入しています: ${dependency}`);
}
NODE

if rg -n "from ['\"](?:node:sqlite|pg|mysql|redis|bull|kafkajs|amqplib)|writeFile|mkdir|createWriteStream|uploadDirectory|@forge|forge-app|feedback-connector-(?:jira-cloud|redmine)" apps/feedback-service/src; then
  fail "Feedback Serviceへ永続化、Forge、provider Connector実装が混入しています"
fi

if rg -n '\[1-5\]\[0-9a-f\]\{3\}' \
  packages/feedback-redmine-core/src packages/feedback-redmine-gateway/src \
  packages/feedback-redmine-plugin/src packages/feedback-redmine-react/src; then
  fail "v1 readerにUUIDv7を拒否する旧version制限が残っています"
fi

packages=(
  @geibee/feedback-gateway
  @geibee/feedback-service
  @geibee/feedback-connector-redmine
  @geibee/feedback-connector-jira-cloud
  @geibee/feedback-client
  @geibee/feedback-controller
  @geibee/feedback-redmine-core
)
for package_name in "${packages[@]}"; do
  echo "[feedback-phase3-package] $package_name"
  npm --workspace "$package_name" run typecheck
  npm --workspace "$package_name" run test
done

echo "[feedback-phase3] PASS"
