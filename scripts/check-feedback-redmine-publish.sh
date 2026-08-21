#!/usr/bin/env bash
# Redmine release公開の再実行・競合・初回公開を外部registryなしで検証する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

test_tmp=$(mktemp -d -t feedback-redmine-publish-check.XXXXXX)
cleanup() {
  if [[ -d "$test_tmp" && "$(basename "$test_tmp")" == feedback-redmine-publish-check.?????? ]]; then
    rm -rf -- "$test_tmp"
  fi
}
trap cleanup EXIT

fail() {
  echo "[feedback-redmine-publish-check] FAIL: $*" >&2
  exit 1
}

fake_bin="$test_tmp/bin"
mkdir -p "$fake_bin"

cat >"$fake_bin/npm" <<'FAKE_NPM'
#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  whoami)
    printf '%s\n' 'geibee'
    ;;
  view)
    if [[ "${3:-}" == version ]]; then
      case "$FAKE_NPM_MODE" in
        same|different) printf '%s\n' '1.2.3-test.1' ;;
        missing)
          if [[ -f "$FAKE_REGISTRY_STATE/npm-published" ]]; then
            printf '%s\n' '1.2.3-test.1'
          else
            echo 'npm error E404 Not Found' >&2
            exit 1
          fi
          ;;
        *) exit 2 ;;
      esac
      exit 0
    fi
    if [[ "${3:-}" == dist.integrity ]]; then
      case "$FAKE_NPM_MODE" in
        same) printf '"%s"\n' "$FAKE_EXPECTED_NPM_INTEGRITY" ;;
        different) printf '%s\n' '"sha512-ZGlmZmVyZW50"' ;;
        missing)
          [[ -f "$FAKE_REGISTRY_STATE/npm-published" ]] || exit 1
          printf '"%s"\n' "$FAKE_EXPECTED_NPM_INTEGRITY"
          ;;
        *) exit 2 ;;
      esac
      exit 0
    fi
    if [[ "${3:-}" == dist-tags ]]; then
      if [[ -f "$FAKE_REGISTRY_STATE/npm-tag-next" ]]; then
        printf '%s\n' '{"next":"1.2.3-test.1","latest":"1.2.3-test.1"}'
      else
        printf '%s\n' '{"latest":"1.2.3-test.1"}'
      fi
      exit 0
    fi
    exit 2
    ;;
  publish)
    printf '%s\n' 'npm publish' >>"$FAKE_CALL_LOG"
    if [[ " $* " == *' --tag next '* ]]; then
      touch "$FAKE_REGISTRY_STATE/npm-tag-next"
    fi
    touch "$FAKE_REGISTRY_STATE/npm-published"
    printf '%s\n' '+ @geibee/feedback-core@1.2.3-test.1'
    ;;
  *) exit 2 ;;
esac
FAKE_NPM

cat >"$fake_bin/skopeo" <<'FAKE_SKOPEO'
#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  login)
    cat >/dev/null
    printf '%s\n' 'skopeo login' >>"$FAKE_CALL_LOG"
    ;;
  inspect)
    case "$FAKE_OCI_MODE" in
      same) printf '%s\n' "$FAKE_EXPECTED_OCI_DIGEST" ;;
      different) printf 'sha256:%064d\n' 0 | tr '0' 'b' ;;
      missing)
        if [[ -f "$FAKE_REGISTRY_STATE/oci-published" ]]; then
          printf '%s\n' "$FAKE_EXPECTED_OCI_DIGEST"
        else
          echo 'manifest unknown' >&2
          exit 1
        fi
        ;;
      *) exit 2 ;;
    esac
    ;;
  copy)
    printf '%s\n' 'skopeo copy' >>"$FAKE_CALL_LOG"
    touch "$FAKE_REGISTRY_STATE/oci-published"
    ;;
  *) exit 2 ;;
esac
FAKE_SKOPEO

chmod 0700 "$fake_bin/npm" "$fake_bin/skopeo"

version=1.2.3-test.1
expected_oci_digest="sha256:$(printf '%064d' 0 | tr '0' 'a')"
node_token='node-auth-secret-for-publish-check'
github_token='github-auth-secret-for-publish-check'

prepare_scenario() {
  local name=$1
  local scenario="$test_tmp/$name"
  local release="$scenario/release"
  mkdir -p "$release" "$scenario/state"
  printf '%s\n' 'package artifact' >"$release/geibee-core-1.2.3-test.1.tgz"
  printf '%s\n' 'OCI archive' >"$release/feedback-redmine-gateway.oci.tar"
  cat >"$release/release-manifest.json" <<EOF
{
  "schemaVersion": "1",
  "product": "feedback-redmine",
  "version": "$version",
  "publishOrder": ["@geibee/feedback-core"],
  "packages": [
    {
      "name": "@geibee/feedback-core",
      "filename": "geibee-core-1.2.3-test.1.tgz"
    }
  ],
  "images": [
    {
      "name": "feedback-redmine-gateway",
      "archive": "feedback-redmine-gateway.oci.tar",
      "indexDigest": "$expected_oci_digest",
      "platforms": ["linux/amd64", "linux/arm64"]
    }
  ]
}
EOF
  (
    cd "$release"
    sha256sum feedback-redmine-gateway.oci.tar geibee-core-1.2.3-test.1.tgz release-manifest.json >SHA256SUMS
  )
  : >"$scenario/calls.log"
}

run_scenario() {
  local name=$1
  local npm_mode=$2
  local oci_mode=$3
  local scenario="$test_tmp/$name"
  local package_file="$scenario/release/geibee-core-1.2.3-test.1.tgz"
  local npm_integrity
  npm_integrity=$(PACKAGE_FILE="$package_file" node -e '
    const { createHash } = require("node:crypto");
    const { readFileSync } = require("node:fs");
    process.stdout.write(`sha512-${createHash("sha512").update(readFileSync(process.env.PACKAGE_FILE)).digest("base64")}`);
  ')
  set +e
  PATH="$fake_bin:$PATH" \
    FAKE_NPM_MODE="$npm_mode" \
    FAKE_OCI_MODE="$oci_mode" \
    FAKE_REGISTRY_STATE="$scenario/state" \
    FAKE_CALL_LOG="$scenario/calls.log" \
    FAKE_EXPECTED_NPM_INTEGRITY="$npm_integrity" \
    FAKE_EXPECTED_OCI_DIGEST="$expected_oci_digest" \
    NODE_AUTH_TOKEN="$node_token" \
    GITHUB_TOKEN="$github_token" \
    GITHUB_ACTOR='feedback-publish-check' \
    bash scripts/publish-feedback-redmine-release.sh \
      --input "$scenario/release" --version "$version" >"$scenario/output.log" 2>&1
  local status=$?
  set -e
  printf '%s' "$status"
}

assert_tokens_hidden() {
  local scenario=$1
  if rg -Fq "$node_token" "$scenario/output.log" "$scenario/calls.log" ||
      rg -Fq "$github_token" "$scenario/output.log" "$scenario/calls.log"; then
    fail "tokenがcommand outputへ出力されました: $(basename "$scenario")"
  fi
}

assert_no_publish() {
  local scenario=$1
  if rg -q '^(npm publish|skopeo copy)$' "$scenario/calls.log"; then
    fail "競合または再利用時にartifactを書き込みました: $(basename "$scenario")"
  fi
}

prepare_scenario same
same_status=$(run_scenario same same same)
[[ "$same_status" == 0 ]] || fail "同一artifactの再実行が失敗しました"
assert_no_publish "$test_tmp/same"
assert_tokens_hidden "$test_tmp/same"
rg -q '同一integrityのため再利用します' "$test_tmp/same/output.log" || fail "npm再利用結果がありません"
rg -q '同一digestのため再利用します' "$test_tmp/same/output.log" || fail "OCI再利用結果がありません"
rg -q '\[feedback-redmine-publish\] PASS' "$test_tmp/same/output.log" || fail "再利用結果がPASSではありません"

prepare_scenario partial
partial_status=$(run_scenario partial same missing)
[[ "$partial_status" == 0 ]] || fail "npm公開後に停止したreleaseを再開できませんでした"
if rg -q '^npm publish$' "$test_tmp/partial/calls.log"; then fail "再開時にnpmを再公開しました"; fi
[[ "$(rg -c '^skopeo copy$' "$test_tmp/partial/calls.log")" == 1 ]] || fail "再開時のOCI公開回数が不正です"
assert_tokens_hidden "$test_tmp/partial"

prepare_scenario npm-conflict
npm_conflict_status=$(run_scenario npm-conflict different same)
[[ "$npm_conflict_status" != 0 ]] || fail "異なるnpm integrityを拒否しませんでした"
assert_no_publish "$test_tmp/npm-conflict"
assert_tokens_hidden "$test_tmp/npm-conflict"

prepare_scenario oci-conflict
oci_conflict_status=$(run_scenario oci-conflict same different)
[[ "$oci_conflict_status" != 0 ]] || fail "異なるOCI digestを拒否しませんでした"
assert_no_publish "$test_tmp/oci-conflict"
assert_tokens_hidden "$test_tmp/oci-conflict"

prepare_scenario missing
missing_status=$(run_scenario missing missing missing)
[[ "$missing_status" == 0 ]] || fail "未公開artifactの公開検証が失敗しました"
[[ "$(rg -c '^npm publish$' "$test_tmp/missing/calls.log")" == 1 ]] || fail "npm publish回数が不正です"
[[ "$(rg -c '^skopeo copy$' "$test_tmp/missing/calls.log")" == 1 ]] || fail "skopeo copy回数が不正です"
assert_tokens_hidden "$test_tmp/missing"
rg -q '\[feedback-redmine-publish\] PASS' "$test_tmp/missing/output.log" || fail "初回公開結果がPASSではありません"

prepare_npm_only_scenario() {
  local scenario="$test_tmp/npm-only"
  local release="$scenario/release"
  mkdir -p "$release" "$scenario/state"
  printf '%s\n' 'package artifact' >"$release/geibee-feedback-core-1.2.3-test.1.tgz"
  cat >"$release/release-manifest.json" <<EOF
{
  "schemaVersion": "1",
  "product": "feedback-redmine",
  "version": "$version",
  "publishOrder": ["@geibee/feedback-core"],
  "packages": [
    {
      "name": "@geibee/feedback-core",
      "filename": "geibee-feedback-core-1.2.3-test.1.tgz"
    }
  ],
  "images": []
}
EOF
  (
    cd "$release"
    sha256sum geibee-feedback-core-1.2.3-test.1.tgz release-manifest.json >SHA256SUMS
  )
  : >"$scenario/calls.log"
}

prepare_npm_only_scenario
npm_only_scenario="$test_tmp/npm-only"
npm_only_package="$npm_only_scenario/release/geibee-feedback-core-1.2.3-test.1.tgz"
npm_only_integrity=$(PACKAGE_FILE="$npm_only_package" node -e '
  const { createHash } = require("node:crypto");
  const { readFileSync } = require("node:fs");
  process.stdout.write(`sha512-${createHash("sha512").update(readFileSync(process.env.PACKAGE_FILE)).digest("base64")}`);
')
PATH="$fake_bin:$PATH" \
  FAKE_NPM_MODE=missing \
  FAKE_REGISTRY_STATE="$npm_only_scenario/state" \
  FAKE_CALL_LOG="$npm_only_scenario/calls.log" \
  FAKE_EXPECTED_NPM_INTEGRITY="$npm_only_integrity" \
  bash scripts/publish-feedback-redmine-release.sh \
    --input "$npm_only_scenario/release" --version "$version" --npm-only --tag next \
    >"$npm_only_scenario/output.log" 2>&1 || fail "npm-only公開検証が失敗しました"
[[ "$(rg -c '^npm publish$' "$npm_only_scenario/calls.log")" == 1 ]] || fail "npm-only publish回数が不正です"
test -f "$npm_only_scenario/state/npm-tag-next" || fail "npm-only公開へnext tagが指定されていません"
if rg -q '^skopeo ' "$npm_only_scenario/calls.log"; then fail "npm-only公開がOCI registryへアクセスしました"; fi
rg -q '\[feedback-redmine-publish\] PASS' "$npm_only_scenario/output.log" || fail "npm-only公開結果がPASSではありません"

echo "[feedback-redmine-publish-check] PASS"
