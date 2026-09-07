#!/usr/bin/env bash
# 汎用化Phase 4のReact／Web Component rendererとbrowser Gateをfail-closedで検査する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

fail() { echo "[feedback-phase4] FAIL: $*" >&2; exit 1; }
for command in node npm rg sha256sum docker; do command -v "$command" >/dev/null 2>&1 || fail "$command が見つかりません"; done

required_files=(
  packages/feedback-react/src/overlay.tsx
  packages/feedback-react/src/overlay.test.tsx
  packages/feedback-web-component/src/element.ts
  packages/feedback-web-component/src/element.test.ts
  packages/feedback-web-component/src/plugin.ts
  packages/feedback-redmine-react/src/v2-compat.test.ts
  tests/fixtures/feedback-web-component-vanilla/src/main.ts
  tests/redmine-browser-e2e/src/renderer-browser-smoke.mjs
  scripts/smoke-feedback-renderers.sh
  docs/phase4/contract-freeze.sha256
  docs/phase4/phase4-gate.md
)
for file in "${required_files[@]}"; do [[ -f "$file" ]] || fail "必須fileがありません: $file"; done

phase4_plan=$(sed -n '/^### Phase 4:/,/^### Phase 5:/p' feedback-system-generalization-plan.md)
if rg -n -- '- \[ \]' <<<"$phase4_plan"; then
  fail "Phase 4 checklistに未完了項目があります"
fi
if rg -n 'TODO|TBD|決定待ち|未決(事項|欄|項目)' docs/phase4; then
  fail "Phase 4 Gate文書に未決表現があります"
fi
rg -Fq 'feedback-v2-contract-2.0.0-alpha.1' docs/phase4/phase4-gate.md \
  || fail "Contract freeze識別子がありません"
# Phase 4 freezeはGate通過時のalpha.1履歴証跡であり、後続release訂正後の現sourceとは比較しない。
# 現行契約はPhase 5 freezeでfail-closedに比較する。
freeze_rows=$(rg -c '^[a-f0-9]{64}  (contracts/feedback/|packages/feedback-(client|connector-sdk|gateway|controller)/|docs/phase2/)' \
  docs/phase4/contract-freeze.sha256)
[[ "$freeze_rows" == "15" ]] || fail "Phase 4 historical freeze manifestが不正です: $freeze_rows"
rg -Fq 'feedback-v2-contract-2.0.0-alpha.1' docs/phase4/phase4-gate.md \
  || fail "Phase 4 historical freeze identifierがありません"

node <<'NODE'
const { readFileSync } = require("node:fs");
const web = JSON.parse(readFileSync("packages/feedback-web-component/package.json", "utf8"));
const react = JSON.parse(readFileSync("packages/feedback-react/package.json", "utf8"));
const webRuntime = Object.keys({ ...(web.dependencies || {}), ...(web.peerDependencies || {}), ...(web.optionalDependencies || {}) });
if (JSON.stringify(webRuntime) !== JSON.stringify(["@geibee/feedback-controller"])) {
  throw new Error(`Web Componentのruntime dependencyがcontrollerだけではありません: ${webRuntime.join(",")}`);
}
if (Object.keys(react.dependencies || {}).join(",") !== "@geibee/feedback-controller" || !(react.peerDependencies?.react)) {
  throw new Error("React rendererのcontroller／React peer dependency境界が不正です");
}
NODE

if rg -n "from ['\"](?:react|react-dom|@geibee/feedback-(?:connector|redmine|jira))|innerHTML|eval\(|new Function|setAttribute\(['\"]on" packages/feedback-web-component/src; then
  fail "標準Web Componentへframework／provider依存またはCSP非互換実装が混入しています"
fi
if rg -n "fetch\(|XMLHttpRequest|localStorage|sessionStorage|setInterval\(|setTimeout\(" packages/feedback-react/src packages/feedback-web-component/src; then
  fail "rendererへtransport、storage、pollingが混入しています"
fi
if rg -n "from ['\"](?:@geibee/feedback-redmine|@geibee/feedback-connector|@geibee/feedback-jira)" packages/feedback-react/src; then
  fail "React rendererへprovider依存が混入しています"
fi

test_packages=(
  @geibee/feedback-controller
  @geibee/feedback-react
  @geibee/feedback-web-component
  @geibee/feedback-redmine-react
)
# v1互換rendererは共通capture／UIの公開dist型を参照する。clean checkoutでは
# consumerのtypecheck前に、Phase 1で固定した依存DAG順で生成する。
npm --workspace @geibee/feedback-dom-capture run build
npm --workspace @geibee/feedback-react-ui run build
for package_name in "${test_packages[@]}"; do
  echo "[feedback-phase4-package] $package_name"
  npm --workspace "$package_name" run typecheck
  npm --workspace "$package_name" run test
done
npm --workspace feedback-web-component-vanilla-fixture run typecheck

bash scripts/smoke-feedback-renderers.sh

echo "[feedback-phase4] PASS"
