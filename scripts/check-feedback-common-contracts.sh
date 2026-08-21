#!/usr/bin/env bash
# 全runtimeが共有するOpenAPI・JSON Schema・core境界を検証する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

fail() { echo "[feedback-common-contract] FAIL: $*" >&2; exit 1; }
openapi=contracts/feedback/openapi.yaml
generated=contracts/feedback/src/generated.ts
[[ -f "$openapi" && -f "$generated" ]] || fail "共有OpenAPIまたは生成型がありません"

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
npx --no-install openapi-typescript "$openapi" -o "$tmp" >/dev/null
diff -u "$generated" "$tmp" || fail "@geibee/feedback-contractsの共有生成型がOpenAPIと同期していません"
npx --no-install spectral lint --ruleset .spectral.yaml "$openapi"

grep -qE '^  /api/' "$openapi" && fail "専用契約にWeb GISの/api pathが混入しています"
grep -qE '/(tiles|layers|lands|buildings|parties|zones|analysis-jobs|import-jobs)(/|:|$)' "$openapi" && \
  fail "専用契約にGIS・業務endpointが混入しています"

for schema in contracts/feedback/schemas/*.json; do
  node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!value["$schema"] || !value["$id"]) process.exit(1)' "$schema" || \
    fail "$schema に\$schemaまたは\$idがありません"
done

if rg -n "from ['\"](react|react-dom|@tanstack/|maplibre-gl)|document\\.|window\\." packages/feedback-core/src; then
  fail "@geibee/feedback-coreにUI/runtime固有依存が混入しています"
fi
node -e '
  const value = require("./packages/feedback-core/package.json");
  const forbidden = ["react", "react-dom", "@tanstack/react-query", "maplibre-gl"];
  if (forbidden.some((name) => value.dependencies?.[name] || value.peerDependencies?.[name])) process.exit(1);
' || fail "@geibee/feedback-coreのpackage dependency境界が不正です"

undocumented_feedback_variables=$(comm -23 \
  <(rg --no-messages -o -P --no-filename '(?<![A-Z0-9_])FEEDBACK_[A-Z][A-Z0-9_]+' \
    apps/feedback-* packages/feedback-* contracts/feedback deploy .github/workflows scripts \
    --glob '!**/node_modules/**' --glob '!**/build/**' --glob '!**/dist/**' \
    | rg -v '^(FEEDBACK_AUTH_NAME|FEEDBACK_EXCHANGE_AUTH_NAME)$' | LC_ALL=C sort -u) \
  <(rg -o --no-filename 'FEEDBACK_[A-Z][A-Z0-9_]+' docs/environment-variables.md | LC_ALL=C sort -u))
[[ -z "$undocumented_feedback_variables" ]] || \
  fail "docs/environment-variables.mdに未記載の変数があります: $undocumented_feedback_variables"

echo "[feedback-common-contract] PASS"
