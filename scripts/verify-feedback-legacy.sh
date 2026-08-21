#!/usr/bin/env bash
# legacy Feedback Service・SDK・管理画面だけを検証する保守品質ゲート。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

log() { echo "[feedback-legacy-verify] $*"; }
fail() { echo "[feedback-legacy-verify] FAIL: $*" >&2; exit 1; }
for command in node npm go docker; do command -v "$command" >/dev/null 2>&1 || fail "$command が見つかりません"; done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2が見つかりません"

node_supported=$(node -p '
  const [major, minor] = process.versions.node.split(".").map(Number);
  String((major === 22 && minor >= 12) || major === 23 || major === 24);
')
[[ "$node_supported" == "true" ]] || fail "Node.js 22.12以上25未満が必要です"
[[ ! -d apps/feedback-service ]] || fail "廃止済みKotlin Feedback Serviceが混入しています"
[[ -f apps/feedback-service-go/migrations/baseline/V1__feedback_baseline.sql ]] || \
  fail "Go-only Feedback Serviceにfresh baselineがありません"
if rg -n 'apps/feedback-service/Dockerfile|eclipse-temurin|openjdk|gradle:' deploy \
    apps/feedback-service-go/Dockerfile >/dev/null; then
  fail "Feedback Serviceのbuild/runtime経路にJDKまたはKotlin image参照があります"
fi
bash -n scripts/build-feedback-sdk-release.sh

if [[ "${FEEDBACK_VERIFY_SKIP_NPM_CI:-0}" != "1" ]]; then
  log "clean npm install"
  npm ci --ignore-scripts --no-audit --no-fund
fi
if [[ "${FEEDBACK_VERIFY_SKIP_SHARED_PACKAGES:-0}" != "1" ]]; then
  for package_name in @geibee/feedback-contracts @geibee/feedback-core; do
    log "$package_name"
    npm --workspace "$package_name" run typecheck
    npm --workspace "$package_name" run test
    npm --workspace "$package_name" run build
  done
fi

bash scripts/check-feedback-legacy-contracts.sh
bash scripts/check-feedback-legacy-container-platforms.sh
bash scripts/verify-feedback-go.sh

for package_name in @geibee/react @geibee/feedback-maplibre @geibee/admin-react; do
  log "$package_name"
  npm --workspace "$package_name" run typecheck
  npm --workspace "$package_name" run test
  npm --workspace "$package_name" run build
done
for application in @geibee/admin-console @geibee/token-broker-reference @geibee/conformance-consumer; do
  log "$application"
  npm --workspace "$application" run typecheck
  npm --workspace "$application" run test
  npm --workspace "$application" run build
done
if [[ "${FEEDBACK_VERIFY_SKIP_PACKAGE_CONSUMERS:-0}" != "1" ]]; then
  bash scripts/check-feedback-packages.sh
fi
bash scripts/check-feedback-conformance.sh

docker compose --env-file deploy/.env.example -f deploy/compose.yaml config --quiet
docker compose --env-file deploy/.env.example -f deploy/compose.yaml \
  --profile go-migration config --format json | node -e '
    const fs = require("node:fs");
    const config = JSON.parse(fs.readFileSync(0, "utf8"));
    const names = [
      "feedback-migrate", "feedback-service", "feedback-bootstrap-east", "feedback-bootstrap-west",
      "feedback-bootstrap-manifest-sync", "feedback-manifest-apply",
      "feedback-notification-worker", "feedback-webhook-connector", "feedback-connector-register",
      "feedback-export-worker", "feedback-retention-worker"
    ];
    for (const name of names) {
      const service = config.services?.[name];
      if (!service) throw new Error(`Feedback runtime serviceがありません: ${name}`);
      if (Number(service.cpus) !== 1) throw new Error(`CPU limit 1.0が未設定です: ${name}`);
      if (Number(service.mem_limit) !== 536870912) throw new Error(`memory limit 512MiBが未設定です: ${name}`);
      if (service.read_only !== true) throw new Error(`read_onlyが未設定です: ${name}`);
      if (!service.cap_drop?.includes("ALL")) throw new Error(`cap_drop ALLが未設定です: ${name}`);
      if (!service.security_opt?.includes("no-new-privileges:true")) throw new Error(`no-new-privilegesが未設定です: ${name}`);
      if (!service.tmpfs?.some((value) => value.startsWith("/tmp:"))) throw new Error(`制限付き/tmp tmpfsが未設定です: ${name}`);
    }
  '

log "PASS"
