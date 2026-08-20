#!/usr/bin/env bash
# ARM開発環境からAzure Container Apps用linux/amd64 imageをQEMUなしで生成できる境界を固定する。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail() { echo "[feedback-container-platform] FAIL: $*" >&2; exit 1; }

node <<'NODE'
const lock = require("./package-lock.json");
// Vite 8のRolldownとLightning CSSについて、glibc/musl・arm64/x64のlockを保持する。
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
if (missing.length) {
  console.error(`[feedback-container-platform] FAIL: platform別optional dependencyが不足しています:\n${missing.join("\n")}`);
  process.exit(1);
}
NODE

for dockerfile in \
  apps/feedback-admin/Dockerfile \
  apps/feedback-conformance-consumer/Dockerfile \
  apps/feedback-token-broker-reference/Dockerfile; do
  grep -Fq 'FROM --platform=$BUILDPLATFORM docker.io/library/node:22-alpine AS build' "$dockerfile" \
    || fail "$dockerfile のNode build stageがBUILDPLATFORMで実行されません"
  [[ "$(grep -c '^FROM ' "$dockerfile")" == "2" ]] \
    || fail "$dockerfile のbuild/runtime stage境界が不正です"
done

for dockerfile in \
  apps/feedback-redmine-gateway-reference/Dockerfile \
  apps/feedback-redmine-demo/Dockerfile; do
  grep -Fq 'FROM --platform=$BUILDPLATFORM docker.io/library/node:22.18.0-bookworm-slim@sha256:' "$dockerfile" \
    || fail "$dockerfile のNode build stageがdigest固定BUILDPLATFORMで実行されません"
  [[ "$(grep -c '^FROM ' "$dockerfile")" == "2" ]] \
    || fail "$dockerfile のbuild/runtime stage境界が不正です"
done
grep -Fq 'FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:' apps/feedback-redmine-gateway-reference/Dockerfile \
  || fail "Feedback Redmine gateway runtime imageがdigest固定distrolessではありません"
grep -Fq 'USER nonroot' apps/feedback-redmine-gateway-reference/Dockerfile \
  || fail "Feedback Redmine gatewayがnon-rootではありません"
grep -Fq 'FROM docker.io/nginxinc/nginx-unprivileged:1.31.4-alpine@sha256:' apps/feedback-redmine-demo/Dockerfile \
  || fail "Feedback Redmine demo runtime imageがdigest固定されていません"
grep -Fq 'USER 101' apps/feedback-redmine-demo/Dockerfile \
  || fail "Feedback Redmine demoがnon-rootではありません"

service_dockerfile=apps/feedback-service-go/Dockerfile
grep -Fq 'FROM --platform=$BUILDPLATFORM docker.io/library/golang:1.26.5-alpine@sha256:' "$service_dockerfile" \
  || fail "Feedback ServiceのGo build stageがBUILDPLATFORMで実行されません"
grep -Fq 'FROM gcr.io/distroless/static-debian12:nonroot@sha256:' "$service_dockerfile" \
  || fail "Feedback Serviceのruntime stageがtarget platform用distroless imageを使用していません"
grep -Fq 'CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_arch" go build' "$service_dockerfile" \
  || fail "Feedback ServiceがTARGETOS/TARGETARCHへクロスコンパイルされません"

echo "[feedback-container-platform] PASS: arm64 build hostからlinux/amd64 runtimeを生成できます"
