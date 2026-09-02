#!/usr/bin/env bash
# 管理Backlog SaaSへrun-ownedデータだけを書き、現revisionのStage B live Conformanceを再実行する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

fail() { echo "[feedback-backlog-live] FAIL: $*" >&2; exit 1; }
for command in node npm jq mktemp; do command -v "$command" >/dev/null 2>&1 || fail "$command が見つかりません"; done
[[ -n "${FEEDBACK_BACKLOG_ACCEPTANCE_BASE_URL:-}" ]] || fail "Backlog acceptance base URLがありません"
[[ -n "${FEEDBACK_BACKLOG_ACCEPTANCE_API_KEY:-}" ]] || fail "Backlog acceptance API keyがありません"
[[ -n "${FEEDBACK_BACKLOG_ACCEPTANCE_PROJECT_KEY:-}" ]] || fail "Backlog acceptance project keyがありません"
[[ "${FEEDBACK_BACKLOG_ACCEPTANCE_CLEANUP_POLICY:-}" == "delete-run-owned" ]] || fail "cleanup policyはdelete-run-owned固定です"

temp_dir=$(mktemp -d /tmp/feedback-backlog-live.XXXXXX)
chmod 700 "$temp_dir"
trap 'rm -f "$temp_dir/evidence.json"; rmdir "$temp_dir" 2>/dev/null || true' EXIT

npm --workspace @geibee/feedback-envelope run build
npm --workspace @geibee/feedback-connector-sdk run build
npm --workspace @geibee/feedback-connector-backlog run build
node scripts/run-feedback-backlog-live-conformance.mjs >"$temp_dir/evidence.json"

jq -e '
  .schemaVersion == "1" and
  .kind == "backlog-stage-b-live-conformance" and
  .contractVersion == "2.0.0-alpha.2" and
  (.implementationDigest | test("^sha256:[a-f0-9]{64}$")) and
  .api == "Backlog API v2" and
  .siteType == "Backlog SaaS free trial" and
  .tenantIdentifiersRemoved == true and
  (.provisioning | [.[]] | all) and
  (.capabilities | [.[]] | all) and
  .recovery.zeroCreateHitPending == true and
  .recovery.createResponseLostAfterCommit == true and
  .recovery.createRecoveredFromProvider == true and
  .recovery.replyResponseLostAfterCommit == true and
  .recovery.replyRecoveredFromProvider == true and
  .recovery.revisionResponseLostAfterCommit == true and
  .recovery.revisionRecoveredFromProvider == true and
  .recovery.duplicateThreadRepairRequired == true and
  .recovery.automaticWriteRetry == false and
  (.roundtrip | [.[]] | all) and
  .restartReconstruction.separateProcess == true and
  .restartReconstruction.providerObjectIdentifiersPassed == false and
  .restartReconstruction.threadRecovered == true and
  .restartReconstruction.intentsRecovered == true and
  .restartReconstruction.resourceProjectionRecovered == true and
  .cleanup == "deleted-all-run-owned-issues" and
  (.executedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$"))
' "$temp_dir/evidence.json" >/dev/null || fail "Backlog live Conformance evidenceが不正です"

current_digest=$(node -e '
  const { createHash } = require("node:crypto");
  const { readFileSync } = require("node:fs");
  const files = [
    "packages/feedback-connector-backlog/src/connector.ts",
    "packages/feedback-connector-backlog/src/http-transport.ts",
    "packages/feedback-connector-backlog/src/provisioning.ts",
    "packages/feedback-connector-backlog/src/rest-v2-client.ts",
    "packages/feedback-connector-backlog/src/types.ts",
    "scripts/run-feedback-backlog-live-conformance.mjs"
  ];
  const digest = createHash("sha256");
  for (const file of files) digest.update(file).update("\0").update(readFileSync(file)).update("\0");
  process.stdout.write(`sha256:${digest.digest("hex")}`);
')
[[ "$(jq -r .implementationDigest "$temp_dir/evidence.json")" == "$current_digest" ]] \
  || fail "Backlog live evidenceが現source revisionへbindingされていません"

cat "$temp_dir/evidence.json"
echo "[feedback-backlog-live] PASS" >&2
