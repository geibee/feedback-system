#!/usr/bin/env bash
# source checkoutからFeedback Redmine評価環境を一括起動する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

command -v node >/dev/null 2>&1 || { echo "Node.jsが必要です" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npmが必要です" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Dockerが必要です" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2が必要です" >&2; exit 1; }

npm --workspace @geibee/feedback-redmine-ops run build
docker build --tag feedback-redmine-gateway:local --file apps/feedback-redmine-gateway-reference/Dockerfile .
docker build --tag feedback-redmine-demo:local --file apps/feedback-redmine-demo/Dockerfile .
node packages/feedback-redmine-ops/dist/cli.js local up \
  --gateway-image feedback-redmine-gateway:local \
  --demo-image feedback-redmine-demo:local \
  "$@"
