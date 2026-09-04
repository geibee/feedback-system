#!/usr/bin/env bash
# Feedback Service OCI publisherの同一digest再実行と衝突拒否を外部通信なしで検証する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

test_root=$(mktemp -d -t feedback-service-publish-check.XXXXXX)
cleanup() {
  if [[ -d "$test_root" && "$(basename "$test_root")" == feedback-service-publish-check.?????? ]]; then
    rm -rf -- "$test_root"
  fi
}
trap cleanup EXIT

release="$test_root/release"
fake_bin="$test_root/bin"
mkdir -p "$release" "$fake_bin"
printf 'oci fixture\n' >"$release/feedback-service-runtime_1.0.0-test.1_linux_multiarch.oci.tar"
cat >"$release/feedback-service-release-manifest.json" <<'JSON'
{
  "schemaVersion": "1",
  "product": "feedback-service",
  "version": "1.0.0-test.1",
  "sourceTreeState": "clean",
  "images": [{
    "name": "feedback-service-runtime",
    "archive": "feedback-service-runtime_1.0.0-test.1_linux_multiarch.oci.tar",
    "indexDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "platforms": ["linux/amd64", "linux/arm64"]
  }]
}
JSON
(
  cd "$release"
  sha256sum feedback-service-runtime_1.0.0-test.1_linux_multiarch.oci.tar \
    feedback-service-release-manifest.json >feedback-service-SHA256SUMS
)

cat >"$fake_bin/skopeo" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  login) exit 0 ;;
  inspect)
    if [[ -f "$FAKE_SKOPEO_STATE/published" || "$FAKE_SKOPEO_MODE" == same ]]; then
      printf '%s\n' "$FAKE_SKOPEO_EXPECTED_DIGEST"
      exit 0
    fi
    if [[ "$FAKE_SKOPEO_MODE" == conflict ]]; then
      printf '%s\n' 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      exit 0
    fi
    echo 'manifest unknown' >&2
    exit 1
    ;;
  copy)
    [[ "$FAKE_SKOPEO_MODE" == missing ]]
    : >"$FAKE_SKOPEO_STATE/published"
    exit 0
    ;;
  *) exit 2 ;;
esac
SH
chmod +x "$fake_bin/skopeo"

run_publish() {
  local mode=$1 state="$test_root/state-$1"
  mkdir -p "$state"
  PATH="$fake_bin:$PATH" GITHUB_TOKEN=fixture GITHUB_ACTOR=fixture GITHUB_REPOSITORY_OWNER=geibee \
    FAKE_SKOPEO_MODE="$mode" FAKE_SKOPEO_STATE="$state" \
    FAKE_SKOPEO_EXPECTED_DIGEST=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    bash scripts/publish-feedback-service-release.sh \
      --input "$release" --version 1.0.0-test.1
}

run_publish same >/dev/null
run_publish missing >/dev/null
if run_publish conflict >"$test_root/conflict.out" 2>"$test_root/conflict.err"; then
  echo "[feedback-service-publish-check] FAIL: 異なるdigestを拒否しませんでした" >&2
  exit 1
fi
rg -Fq '同じversionに異なるdigestが存在します' "$test_root/conflict.err"

sed -i 's/"sourceTreeState": "clean"/"sourceTreeState": "dirty"/' \
  "$release/feedback-service-release-manifest.json"
(
  cd "$release"
  sha256sum feedback-service-runtime_1.0.0-test.1_linux_multiarch.oci.tar \
    feedback-service-release-manifest.json >feedback-service-SHA256SUMS
)
if run_publish same >"$test_root/dirty.out" 2>"$test_root/dirty.err"; then
  echo "[feedback-service-publish-check] FAIL: dirty sourceの成果物を拒否しませんでした" >&2
  exit 1
fi
rg -Fq 'Feedback Service release manifestが不正です' "$test_root/dirty.err"

echo "[feedback-service-publish-check] PASS"
