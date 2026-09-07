#!/usr/bin/env bash
# 管理Jira Cloud siteへrun-ownedデータだけを書き、現revisionのlive acceptanceをその場で再実行する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

fail() { echo "[feedback-phase5-live] FAIL: $*" >&2; exit 1; }
for command in node npm jq mktemp; do command -v "$command" >/dev/null 2>&1 || fail "$command が見つかりません"; done

credential_fifo=${FEEDBACK_JIRA_ACCEPTANCE_CREDENTIAL_FIFO:-}
email=${FEEDBACK_JIRA_ACCEPTANCE_EMAIL:-}
api_token=${FEEDBACK_JIRA_ACCEPTANCE_API_TOKEN:-}
if [[ -n "$credential_fifo" ]]; then
  [[ -p "$credential_fifo" ]] || fail "credential FIFOではありません"
  exec 3<"$credential_fifo"
  IFS= read -r email <&3 || fail "FIFOからemailを読めません"
  IFS= read -r api_token <&3 || fail "FIFOからAPI tokenを読めません"
  exec 3<&-
fi
[[ -n "$email" ]] || fail "Jira acceptance emailがありません"
[[ -n "$api_token" ]] || fail "Jira acceptance API tokenがありません"
[[ -n "${FEEDBACK_JIRA_ACCEPTANCE_SITE_URL:-}" ]] || fail "FEEDBACK_JIRA_ACCEPTANCE_SITE_URLがありません"
[[ -n "${FEEDBACK_JIRA_ACCEPTANCE_PROJECT_KEY:-}" ]] || fail "FEEDBACK_JIRA_ACCEPTANCE_PROJECT_KEYがありません"
[[ "${FEEDBACK_JIRA_ACCEPTANCE_CLEANUP_POLICY:-}" == "delete-run-owned" ]] || fail "cleanup policyはdelete-run-owned固定です"

temp_dir=$(mktemp -d /tmp/feedback-phase5-live.XXXXXX)
chmod 700 "$temp_dir"
trap 'rm -f "$temp_dir/evidence.json"; rmdir "$temp_dir" 2>/dev/null || true' EXIT

bash scripts/build-feedback-live-dependencies.sh

FEEDBACK_JIRA_ACCEPTANCE_EMAIL=$email \
FEEDBACK_JIRA_ACCEPTANCE_API_TOKEN=$api_token \
node scripts/run-feedback-jira-live-acceptance.mjs >"$temp_dir/evidence.json"
unset email api_token

jq -e '
  .schemaVersion == "1" and
  .kind == "jira-cloud-phase5-live-acceptance" and
  .contractVersion == "2.0.0-alpha.3" and
  (.implementationDigest | test("^sha256:[a-f0-9]{64}$")) and
  .api == "Jira Cloud REST API v3" and
  .siteType == "Forge development demo" and
  .tenantIdentifiersRemoved == true and
  .runOwnedIssueCreated == true and
  .firstWriteTripletRecovered == true and
  .commentRoundtrip == true and
  .revisionRoundtrip == true and
  .bodyIntegrityVerified == true and
  .attachmentRoundtrip == true and
  .attachmentMessageBindingVerified == true and
  .threadReference.publicCredential == true and
  .threadReference.create == true and
  .threadReference.read == true and
  .threadReference.reply == true and
  .threadReference.revision == true and
  .threadReference.recovery == true and
  .threadReference.serviceReconstruction == true and
  .threadReference.noSearchFallback == true and
  .threadReference.tamperRejected == true and
  .threadReference.scopeRejected == true and
  .threadReference.currentAuthorization == true and
  .threadReference.attachment == "verified" and
  .automaticWriteRetry == false and
  .cleanup == "deleted-run-owned-issue" and
  (.executedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$"))
' "$temp_dir/evidence.json" >/dev/null || fail "live acceptance evidenceが不正です"

current_digest=$(node scripts/lib/feedback-live-digest.mjs jira-cloud)
[[ "$(jq -r .implementationDigest "$temp_dir/evidence.json")" == "$current_digest" ]] \
  || fail "live evidenceが現source revisionへbindingされていません"

cat "$temp_dir/evidence.json"
echo "[feedback-phase5-live] PASS" >&2
