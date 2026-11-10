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
# zlib修正版を含まない旧digestへのrollbackをgateway／service双方で拒否する。
# CVE-2026-76844／CVE-2026-85091: Debian 13修正版は1:1.3.dfsg+really1.3.1-1+deb13u1。
vulnerable_runtime_digest=ec2313763dd43931543bd03830466e0c409ce73a487e8d46f10db72d3b816c1c
gateway_runtime=$(grep '^FROM gcr.io/distroless/' apps/feedback-redmine-gateway-reference/Dockerfile || true)
for dockerfile in apps/feedback-redmine-gateway-reference/Dockerfile apps/feedback-service-runtime/Dockerfile; do
  grep -Eq '^FROM gcr\.io/distroless/nodejs22-debian13:nonroot@sha256:[a-f0-9]{64}$' "$dockerfile" || \
    fail "$dockerfile のruntime imageがdigest固定distrolessではありません"
  if grep -Fq "@sha256:$vulnerable_runtime_digest" "$dockerfile"; then
    fail "$dockerfile が脆弱なzlibを含む旧runtime digestへ戻っています"
  fi
  [[ "$(grep '^FROM gcr.io/distroless/' "$dockerfile")" == "$gateway_runtime" ]] || \
    fail "gatewayとserviceのruntime imageが一致しません"
  grep -Fxq 'USER nonroot' "$dockerfile" || fail "$dockerfile がnon-rootではありません"
done
grep -Fq 'FROM docker.io/nginxinc/nginx-unprivileged:1.31.4-alpine@sha256:' apps/feedback-redmine-demo/Dockerfile || \
  fail "demo runtime imageがdigest固定されていません"
grep -Fq 'USER 101' apps/feedback-redmine-demo/Dockerfile || fail "demoがnon-rootではありません"

# digest固定のベースに残る脆弱なBrotliへ戻らないことを検証する。
grep -Eq "^[[:space:]]*&& apk add --upgrade --no-cache 'brotli-libs>=1\.2\.1-r0'" apps/feedback-redmine-demo/Dockerfile || \
  fail "demo runtimeでCVE-2026-111497の修正版Brotliを要求していません"

# digest固定のベースに残る脆弱なcurl/libcurlへ戻らないことを検証する。
grep -Eq "^[[:space:]]*'curl>=8\\.23\\.0-r0' 'libcurl>=8\\.23\\.0-r0'" apps/feedback-redmine-demo/Dockerfile || \
  fail "demo runtimeでCVE-2026-92392の修正版curl/libcurlを要求していません"

# muslと同じsource packageのmusl-utilsも修正版へ更新する。
grep -Eq "^[[:space:]]*'musl>=1\\.2\\.6-r3' 'musl-utils>=1\\.2\\.6-r3'" apps/feedback-redmine-demo/Dockerfile || \
  fail "demo runtimeでCVE-2026-107891の修正版musl/musl-utilsを要求していません"

echo "[feedback-redmine-container-platform] PASS"
