#!/usr/bin/env bash
# v2標準Web Componentをvanilla consumer、strict CSP、hostile CSS下の実Chromeで検証する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

fail() { echo "[feedback-renderer-smoke] FAIL: $*" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || fail "Dockerが見つかりません"

npm --workspace @geibee/feedback-web-component run build
npm --workspace feedback-web-component-vanilla-fixture run build

playwright_image='mcr.microsoft.com/playwright@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e'
docker run --rm --ipc=host \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -v "$ROOT:/work:ro" -w /work \
  "$playwright_image" npm run test:renderer:chrome --workspace @geibee/redmine-browser-e2e

echo "[feedback-renderer-smoke] PASS"
