#!/usr/bin/env bash
# Redmine plugin/gateway/extensionのbundleとbrowser security invariantを検証する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

fail() { echo "[feedback-redmine-security] FAIL: $*" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || fail "Dockerが見つかりません"

node <<'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync("apps/feedback-redmine-extension/manifest.json", "utf8"));
if (manifest.manifest_version !== 3) throw new Error("Manifest V3ではありません");
if (JSON.stringify(manifest.permissions) !== JSON.stringify(["storage", "scripting", "activeTab"])) {
  throw new Error("required permission allowlistが不正です");
}
if ("host_permissions" in manifest || JSON.stringify(manifest.optional_host_permissions) !== JSON.stringify(["https://*/*"])) {
  throw new Error("host permissionがoptionalではありません");
}
if (manifest.content_security_policy?.extension_pages !== "script-src 'self'; object-src 'self'") {
  throw new Error("extension CSPが不正です");
}
if (manifest.storage?.managed_schema !== "managed-policy-schema.json") {
  throw new Error("managed policy schemaがmanifestへ接続されていません");
}
NODE

npm --workspace @feedback/redmine-extension run build
first_zip=$(sha256sum apps/feedback-redmine-extension/dist/feedback-redmine-extension.zip | cut -d' ' -f1)
npm --workspace @feedback/redmine-extension run build
second_zip=$(sha256sum apps/feedback-redmine-extension/dist/feedback-redmine-extension.zip | cut -d' ' -f1)
[[ "$first_zip" == "$second_zip" ]] || fail "extension ZIPがdeterministicではありません"

if find apps/feedback-redmine-extension/dist packages/feedback-redmine-plugin/dist -type f -name '*.map' -print -quit | grep -q .; then
  fail "browser artifactにsource mapが混入しています"
fi
if rg -n 'process\.env|eval\(|new Function\(|transient-test-key|expired-key|session-only-browser-key|local-conformance-password' \
  apps/feedback-redmine-extension/dist packages/feedback-redmine-plugin/dist; then
  fail "browser artifactにNode runtime、dynamic code、test credentialが混入しています"
fi
if rg -n "https?://[^\"' ]+\\.js" apps/feedback-redmine-extension/dist packages/feedback-redmine-plugin/dist; then
  fail "browser artifactにremote script URLが混入しています"
fi

playwright_image='mcr.microsoft.com/playwright@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e'
docker run --rm --ipc=host \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -v "$ROOT:/work:ro" -w /work \
  "$playwright_image" npm run test:chrome --workspace @feedback/redmine-browser-e2e

gateway_image='feedback-redmine-gateway-reference:verification'
docker build -f apps/feedback-redmine-gateway-reference/Dockerfile -t "$gateway_image" .
[[ "$(docker image inspect "$gateway_image" --format '{{.Config.User}}')" == "node" ]] || fail "gateway imageがnon-rootではありません"

gateway_tmp=$(mktemp -d -t feedback-redmine-gateway.XXXXXX)
gateway_container="feedback-redmine-gateway-smoke-$RANDOM-$$"
cleanup_gateway() {
  docker rm -f "$gateway_container" >/dev/null 2>&1 || true
  if [[ -d "$gateway_tmp" && "$(basename "$gateway_tmp")" == feedback-redmine-gateway.* ]]; then
    rm -rf -- "$gateway_tmp"
  fi
}
trap cleanup_gateway EXIT

GATEWAY_TMP="$gateway_tmp" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const directory = process.env.GATEWAY_TMP;
const client = {
  schemaVersion: "1", id: "container-smoke", displayName: "Container Smoke",
  applicationKey: "inventory", environmentKey: "test", externalWorkspaceKey: "container-smoke",
  perspectives: [{ code: "ux", label: "UI/UX" }],
  capture: { enabled: true, maximumUploadBytes: 1048576, contentTypes: ["image/png"] },
  attachments: { maximumInlinePreviewBytes: 1048576, maximumDownloadBytes: 1048576 }
};
const profile = {
  profileId: "container-smoke", clientProfileRef: "client.json", redmineBaseUrl: "https://redmine.example.invalid",
  projectId: 1, trackerId: 1, isPrivate: true, defaultPriorityId: null,
  customFieldIds: {
    threadId: 1, requestHash: 2, applicationKey: 3, environmentKey: 4, externalWorkspaceKey: 5, pageKey: 6,
    hostResourceKey: 7, perspectiveCode: 8, locator: 9, submittedById: 10, submittedByName: 11, submissionChannel: 12
  },
  authorizationMode: "resource-scoped", showRedmineLink: false, secretRef: "FEEDBACK_REDMINE_GATEWAY_API_KEY"
};
fs.writeFileSync(path.join(directory, "client.json"), `${JSON.stringify(client)}\n`);
fs.writeFileSync(path.join(directory, "profile.json"), `${JSON.stringify(profile)}\n`);
NODE

gateway_api_key=$(openssl rand -hex 32)
gateway_session_secret=$(openssl rand -hex 64)
docker run -d --name "$gateway_container" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL --security-opt no-new-privileges:true -p 127.0.0.1::8080 \
  -v "$gateway_tmp:/config:ro" \
  -e FEEDBACK_REDMINE_GATEWAY_PROFILE_FILE=/config/profile.json \
  -e FEEDBACK_REDMINE_GATEWAY_API_KEY="$gateway_api_key" \
  -e FEEDBACK_REDMINE_GATEWAY_SESSION_SECRET="$gateway_session_secret" \
  "$gateway_image" >/dev/null

gateway_port=$(docker port "$gateway_container" 8080/tcp | sed -E 's/.*:([0-9]+)$/\1/')
ready=0
status=000
for _attempt in $(seq 1 40); do
  status=$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "Origin: http://127.0.0.1:$gateway_port" -H 'Sec-Fetch-Site: same-origin' \
    "http://127.0.0.1:$gateway_port/internal/feedback-redmine/v1/profiles/container-smoke" || true)
  if [[ "$status" == "401" ]]; then ready=1; break; fi
  sleep 0.25
done
if [[ "$ready" != "1" ]]; then
  docker logs "$gateway_container" >&2 || true
  fail "gateway imageのread-only起動probeが401になりません: HTTP $status"
fi

echo "[feedback-redmine-security] PASS"
