#!/usr/bin/env bash
# Redmine導入CLI、ローカルCompose、provisionerの配布境界を検証する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

fail() { echo "[feedback-redmine-ops] FAIL: $*" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || fail "Dockerが必要です"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2が必要です"

node packages/feedback-redmine-ops/dist/cli.js --help | grep -Fq 'Feedback Redmine導入・運用CLI' \
  || fail "CLI helpを実行できません"

state_directory=$(mktemp -d -t feedback-redmine-ops-check.XXXXXX)
cleanup() {
  if [[ -d "$state_directory" && "$(basename "$state_directory")" == feedback-redmine-ops-check.?????? ]]; then
    rm -rf -- "$state_directory"
  fi
}
trap cleanup EXIT

touch "$state_directory/database.yml" "$state_directory/installation.json"
compose_file=packages/feedback-redmine-ops/assets/local-compose.yaml
FEEDBACK_REDMINE_COMPOSE_PROJECT=feedback-redmine-0123456789ab \
FEEDBACK_REDMINE_STATE_DIR="$state_directory" \
FEEDBACK_REDMINE_OPS_ASSETS="$ROOT/packages/feedback-redmine-ops/assets" \
FEEDBACK_REDMINE_HOST_UID=1000 \
FEEDBACK_REDMINE_HOST_GID=1000 \
FEEDBACK_REDMINE_DB_PASSWORD=verification-only \
FEEDBACK_REDMINE_SECRET_KEY_BASE=verification-only \
FEEDBACK_PARTICIPANT_SIGNING_KEY=verification-only-participant-key-32-bytes \
FEEDBACK_REDMINE_ADMIN_PORT=3001 \
FEEDBACK_REDMINE_DEMO_PORT=4173 \
FEEDBACK_REDMINE_GATEWAY_IMAGE=feedback-redmine-gateway:verification \
FEEDBACK_REDMINE_DEMO_IMAGE=feedback-redmine-demo:verification \
docker compose -f "$compose_file" config --format json >"$state_directory/compose.json"

COMPOSE_CONFIG="$state_directory/compose.json" node <<'NODE'
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.env.COMPOSE_CONFIG, "utf8"));
for (const name of ["feedback-redmine-db", "feedback-redmine", "feedback-redmine-bootstrap", "feedback-redmine-gateway", "feedback-redmine-demo"]) {
  if (!config.services?.[name]) throw new Error(`serviceがありません: ${name}`);
}
for (const name of ["feedback-redmine-gateway", "feedback-redmine-demo"]) {
  const service = config.services[name];
  if (service.read_only !== true || !service.cap_drop?.includes("ALL") ||
      !service.security_opt?.includes("no-new-privileges:true")) {
    throw new Error(`container hardeningが不足しています: ${name}`);
  }
}
for (const name of ["feedback-redmine", "feedback-redmine-demo"]) {
  const ports = config.services[name].ports ?? [];
  if (ports.some((item) => item.host_ip !== "127.0.0.1")) throw new Error(`loopback以外へportを公開しています: ${name}`);
}
if (!config.volumes?.["feedback-redmine-db"] || !config.volumes?.["feedback-redmine-files"]) {
  throw new Error("Redmine DB/filesの永続volumeがありません");
}
NODE

redmine_image=$(sed -n 's/^    image: \(redmine:[^ ]*\)$/\1/p' "$compose_file" | head -n 1)
[[ -n "$redmine_image" ]] || fail "Redmine imageを取得できません"
docker run --rm --entrypoint ruby \
  --volume "$ROOT/packages/feedback-redmine-ops/assets/provision.rb:/ops/provision.rb:ro" \
  "$redmine_image" -c /ops/provision.rb | grep -Fq 'Syntax OK' \
  || fail "provision.rbのsyntaxが不正です"

echo "[feedback-redmine-ops] PASS"
