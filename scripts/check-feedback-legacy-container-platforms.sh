#!/usr/bin/env bash
# legacy Node applicationsとGo Serviceのcross-platform build境界を固定する。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail() { echo "[feedback-legacy-container-platform] FAIL: $*" >&2; exit 1; }
for dockerfile in \
  apps/feedback-admin/Dockerfile \
  apps/feedback-conformance-consumer/Dockerfile \
  apps/feedback-token-broker-reference/Dockerfile; do
  grep -Fq 'FROM --platform=$BUILDPLATFORM docker.io/library/node:22-alpine AS build' "$dockerfile" || \
    fail "$dockerfile のNode build stageがBUILDPLATFORMではありません"
  [[ "$(grep -c '^FROM ' "$dockerfile")" == "2" ]] || fail "$dockerfile のstage境界が不正です"
done

service_dockerfile=apps/feedback-service-go/Dockerfile
grep -Fq 'FROM --platform=$BUILDPLATFORM docker.io/library/golang:1.26.5-alpine@sha256:' "$service_dockerfile" || \
  fail "Go build stageがBUILDPLATFORMではありません"
grep -Fq 'FROM gcr.io/distroless/static-debian12:nonroot@sha256:' "$service_dockerfile" || \
  fail "Go runtime stageがtarget platform用distrolessではありません"
grep -Fq 'CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_arch" go build' "$service_dockerfile" || \
  fail "Go ServiceがTARGETOS/TARGETARCHへcross compileされません"

echo "[feedback-legacy-container-platform] PASS"
