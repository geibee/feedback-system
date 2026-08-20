#!/usr/bin/env bash
# Redmine gateway/demoをbuild hostと独立したruntime platformへ生成できる境界を固定する。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail() { echo "[feedback-redmine-container-platform] FAIL: $*" >&2; exit 1; }

node <<'NODE'
const lock = require("./package-lock.json");
const required = [
  "node_modules/@rolldown/binding-linux-arm64-gnu",
  "node_modules/@rolldown/binding-linux-arm64-musl",
  "node_modules/@rolldown/binding-linux-x64-gnu",
  "node_modules/@rolldown/binding-linux-x64-musl",
  "node_modules/lightningcss-linux-arm64-gnu",
  "node_modules/lightningcss-linux-arm64-musl",
  "node_modules/lightningcss-linux-x64-gnu",
  "node_modules/lightningcss-linux-x64-musl"
];
const missing = required.filter((path) => !lock.packages?.[path]);
if (missing.length) throw new Error(`platform別optional dependencyが不足しています:\n${missing.join("\n")}`);
NODE

for dockerfile in apps/feedback-redmine-gateway-reference/Dockerfile apps/feedback-redmine-demo/Dockerfile; do
  grep -Fq 'FROM --platform=$BUILDPLATFORM docker.io/library/node:22.18.0-bookworm-slim@sha256:' "$dockerfile" || \
    fail "$dockerfile のNode build stageがdigest固定BUILDPLATFORMではありません"
  [[ "$(grep -c '^FROM ' "$dockerfile")" == "2" ]] || fail "$dockerfile のstage境界が不正です"
done
grep -Fq 'FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:' apps/feedback-redmine-gateway-reference/Dockerfile || \
  fail "gateway runtime imageがdigest固定distrolessではありません"
grep -Fq 'USER nonroot' apps/feedback-redmine-gateway-reference/Dockerfile || fail "gatewayがnon-rootではありません"
grep -Fq 'FROM docker.io/nginxinc/nginx-unprivileged:1.31.4-alpine@sha256:' apps/feedback-redmine-demo/Dockerfile || \
  fail "demo runtime imageがdigest固定されていません"
grep -Fq 'USER 101' apps/feedback-redmine-demo/Dockerfile || fail "demoがnon-rootではありません"

echo "[feedback-redmine-container-platform] PASS"
