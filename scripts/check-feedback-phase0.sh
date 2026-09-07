#!/usr/bin/env bash
# 汎用化Phase 0のADR、互換台帳、固定fixtureをfail-closedで検査する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

fail() { echo "[feedback-phase0] FAIL: $*" >&2; exit 1; }
command -v node >/dev/null 2>&1 || fail "Node.jsが見つかりません"
command -v rg >/dev/null 2>&1 || fail "rgが見つかりません"

required_files=(
  docs/adr/0001-db-less-topology-and-authorization-modes.md
  docs/adr/0002-signed-grant-contract.md
  docs/adr/0003-envelope-canonicalization-and-key-separation.md
  docs/adr/0004-contract-ownership-and-v1-v2-boundary.md
  docs/phase0/compatibility-ledger.md
  docs/phase0/envelope-test-vectors.json
  docs/phase0/jira-cloud-constraints.md
  packages/feedback-redmine-gateway/src/v1-characterization.test.ts
  packages/feedback-redmine-react/src/phase0-characterization.test.tsx
  packages/feedback-redmine-plugin/src/phase0-characterization.test.tsx
  feedback-system-generalization-design.md
  feedback-system-generalization-plan.md
)
for file in "${required_files[@]}"; do
  [[ -f "$file" ]] || fail "必須fileがありません: $file"
done

if rg -n 'TODO|TBD|決定待ち|未決(事項|欄|項目)' docs/adr/000{1,2,3,4}-*.md; then
  fail "Phase 0 ADRに未決表現があります"
fi

required_plan_phrases=(
  'exactly-once、不変監査、provider障害中のoffline read'
  '`threadId`、`intentId`、`requestHash`を同じ操作で同時に保存'
  '`threadId`からticketを一意に再解決'
  '`recoverable`または`best-effort`'
  '結果不明時にbinary bodyを自動再uploadしない'
  '検索projectionは候補抽出専用'
  '`feedback:attachment:upload`'
)
for phrase in "${required_plan_phrases[@]}"; do
  rg -Fq "$phrase" feedback-system-generalization-plan.md || fail "初期v2保証範囲が計画書にありません: $phrase"
done

for phrase in 'public-profile' 'signed-grant' 'remote-authorization' 'modeを変更しない' 'Jira Cloud'; do
  rg -Fq "$phrase" docs/adr/0001-db-less-topology-and-authorization-modes.md \
    || fail "topology／認可ADRの固定値がありません: $phrase"
done

for phrase in '300秒' '330秒' 'urn:geibee:feedback-service:<serviceId>' 'feedback:attachment:upload'; do
  rg -Fq "$phrase" docs/adr/0002-signed-grant-contract.md \
    || fail "signed grant ADRの固定値がありません: $phrase"
done

for phrase in 'RFC 8785' 'feedback-envelope\n2\n' 'participant ID導出用HMAC-SHA-256 key'; do
  rg -Fq "$phrase" docs/adr/0003-envelope-canonicalization-and-key-separation.md \
    || fail "Envelope ADRの固定値がありません: $phrase"
done

fixture_count=$(find tests/fixtures/jira-cloud-phase0 -maxdepth 1 -type f -name '*.json' | wc -l | tr -d ' ')
[[ "$fixture_count" == "8" ]] || fail "Jira Cloud JSON fixtureは8件必要です: actual=$fixture_count"
while IFS= read -r -d '' fixture; do
  node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$fixture"
done < <(find tests/fixtures/jira-cloud-phase0 -maxdepth 1 -type f -name '*.json' -print0)

node --input-type=module <<'NODE'
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

for (const name of readdirSync("tests/fixtures/jira-cloud-phase0").filter((value) => value.endsWith(".json"))) {
  const fixture = JSON.parse(readFileSync(`tests/fixtures/jira-cloud-phase0/${name}`, "utf8"));
  if (fixture.fixtureVersion !== 1 || !fixture.kind?.startsWith("jira-cloud-")) {
    throw new Error(`Jira Cloud fixture headerが不正です: ${name}`);
  }
  if (!fixture.expectedConnectorDecision || fixture.provenance?.apiVersion !== "3") {
    throw new Error(`Jira Cloud fixtureのdecisionまたはAPI versionが不正です: ${name}`);
  }
  if (fixture.provenance?.observedOnLiveTenant !== false || !fixture.requiresLiveConfirmation?.length) {
    throw new Error(`Jira Cloud fixtureをlive検証済みとして扱っています: ${name}`);
  }
}

const document = JSON.parse(readFileSync("docs/phase0/envelope-test-vectors.json", "utf8"));
if (document.schemaVersion !== "phase0-envelope-test-vectors-v1") {
  throw new Error("Envelope test vectorのschemaVersionが不正です");
}
if (document.algorithm !== "HS256" || document.testOnlyKey?.encoding !== "hex") {
  throw new Error("Envelope test vectorのalgorithmまたはkey encodingが不正です");
}
const canonicalize = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
};
const key = Buffer.from(document.testOnlyKey.value, "hex");
const purposes = new Set();
for (const vector of document.vectors ?? []) {
  purposes.add(vector.purpose);
  const canonicalPayload = canonicalize(vector.payload);
  if (canonicalPayload !== vector.canonicalPayload) {
    throw new Error(`canonical payload drift: ${vector.name}`);
  }
  if (Buffer.from(vector.domainSeparator, "utf8").toString("hex") !== vector.domainSeparatorHex) {
    throw new Error(`domain separator drift: ${vector.name}`);
  }
  const signature = createHmac("sha256", key)
    .update(vector.domainSeparator + canonicalPayload, "utf8")
    .digest("base64url");
  if (signature !== vector.signature) throw new Error(`signature drift: ${vector.name}`);
}
for (const purpose of ["envelope", "message-marker", "participant-credential"]) {
  if (!purposes.has(purpose)) throw new Error(`test vectorが不足しています: ${purpose}`);
}
const negativeCases = new Set((document.negativeCases ?? []).map(({ name }) => name));
for (const name of [
  "signature-property-is-excluded",
  "provider-profile-tamper",
  "provider-installation-tamper",
  "provider-object-replay",
  "unknown-kid",
  "cross-purpose-key",
  "verify-only-old-key"
]) {
  if (!negativeCases.has(name)) throw new Error(`negative caseが不足しています: ${name}`);
}
NODE

echo "[feedback-phase0] PASS"
