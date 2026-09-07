#!/usr/bin/env bash
# 汎用化Phase 1の契約、package DAG、contract-only skeletonをfail-closedで検査する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

fail() { echo "[feedback-phase1] FAIL: $*" >&2; exit 1; }
for command in node npm rg; do command -v "$command" >/dev/null 2>&1 || fail "$command が見つかりません"; done

required_files=(
  contracts/feedback/feedback-gateway.openapi.yaml
  contracts/feedback/src/feedback-gateway.generated.ts
  contracts/feedback/src/v2.ts
  contracts/feedback/src/v2-server.ts
  contracts/feedback/schemas/feedback-domain.schema.json
  contracts/feedback/schemas/feedback-envelope.schema.json
  contracts/feedback/schemas/feedback-message-marker.schema.json
  contracts/feedback/schemas/feedback-provider-profile.schema.json
  contracts/feedback/schemas/feedback-service-settings.schema.json
  contracts/feedback/schemas/feedback-projection.schema.json
  contracts/feedback/schemas/feedback-authorization.schema.json
  contracts/feedback/fixtures/v2/stable-ordering-unread.json
  contracts/feedback/fixtures/v2/request-hash-vector.json
  packages/feedback-client/src/index.ts
  packages/feedback-connector-sdk/src/index.ts
  packages/feedback-envelope/src/index.ts
  packages/feedback-gateway/src/index.ts
  packages/feedback-controller/src/index.ts
  packages/feedback-controller/src/fixtures/controller-snapshot.golden.ts
  packages/feedback-web-component/src/index.ts
  packages/feedback-react/src/index.ts
  packages/feedback-connector-redmine/src/index.ts
  packages/feedback-connector-jira-cloud/src/index.ts
  apps/feedback-service/src/index.ts
  docs/phase1/contract-freeze-candidates.md
  docs/phase1/hard-gate-1.md
)
for file in "${required_files[@]}"; do [[ -f "$file" ]] || fail "必須fileがありません: $file"; done

node <<'NODE'
const fs = require("node:fs");
const root = JSON.parse(fs.readFileSync("package.json", "utf8"));
const expected = new Map([
  ["packages/feedback-client", ["@geibee/feedback-contracts"]],
  ["packages/feedback-connector-sdk", ["@geibee/feedback-contracts"]],
  ["packages/feedback-envelope", ["@geibee/feedback-contracts"]],
  ["packages/feedback-gateway", ["@geibee/feedback-connector-sdk", "@geibee/feedback-contracts"]],
  ["packages/feedback-controller", ["@geibee/feedback-client", "@geibee/feedback-contracts"]],
  ["packages/feedback-web-component", ["@geibee/feedback-controller"]],
  ["packages/feedback-react", ["@geibee/feedback-controller"]],
  ["packages/feedback-connector-redmine", ["@geibee/feedback-connector-sdk", "@geibee/feedback-envelope"]],
  ["packages/feedback-connector-jira-cloud", ["@geibee/feedback-connector-sdk", "@geibee/feedback-envelope"]],
  ["apps/feedback-service", ["@geibee/feedback-connector-sdk", "@geibee/feedback-contracts", "@geibee/feedback-envelope", "@geibee/feedback-gateway"]]
]);
const workspacePaths = new Set(root.workspaces);
const manifests = new Map();
const names = new Map();
for (const workspace of root.workspaces) {
  const manifest = JSON.parse(fs.readFileSync(`${workspace}/package.json`, "utf8"));
  if (manifest.version !== root.version) throw new Error(`workspace versionがrootと不一致です: ${workspace}`);
  if (names.has(manifest.name)) throw new Error(`workspace package名が重複しています: ${manifest.name}`);
  manifests.set(workspace, manifest);
  names.set(manifest.name, workspace);
}
for (const [workspace, dependencies] of expected) {
  if (!workspacePaths.has(workspace)) throw new Error(`Phase 1 workspaceがrootにありません: ${workspace}`);
  const manifest = manifests.get(workspace);
  if (!manifest || manifest.private !== true || manifest.type !== "module") {
    throw new Error(`Phase 1 manifest境界が不正です: ${workspace}`);
  }
  const actual = Object.keys(manifest.dependencies || {}).sort();
  const wanted = [...dependencies].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`Phase 1 dependencyがDAG契約と不一致です: ${workspace}: ${actual.join(",")}`);
  }
  for (const dependency of actual) {
    if (manifest.dependencies[dependency] !== root.version) {
      throw new Error(`内部dependencyはexact versionが必要です: ${workspace} -> ${dependency}`);
    }
  }
  for (const script of ["typecheck", "test", "build"]) {
    if (!manifest.scripts?.[script]) throw new Error(`Phase 1 scriptがありません: ${workspace}:${script}`);
  }
}

const edges = new Map([...names].map(([name]) => [name, []]));
for (const manifest of manifests.values()) {
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const dependency of Object.keys(manifest[section] || {})) {
      if (names.has(dependency)) edges.get(manifest.name).push(dependency);
    }
  }
}
const visiting = new Set();
const visited = new Set();
function visit(name, path = []) {
  if (visiting.has(name)) throw new Error(`workspace dependency cycle: ${[...path, name].join(" -> ")}`);
  if (visited.has(name)) return;
  visiting.add(name);
  for (const dependency of edges.get(name) || []) visit(dependency, [...path, name]);
  visiting.delete(name);
  visited.add(name);
}
for (const name of edges.keys()) visit(name);

const serviceDependencies = {
  ...(manifests.get("apps/feedback-service").dependencies || {}),
  ...(manifests.get("apps/feedback-service").optionalDependencies || {})
};
const forbiddenServiceDependencies = /(prisma|sequelize|typeorm|mongoose|postgres|mysql|sqlite|redis|bull|queue|kafka|amqp|rabbit|memcached|cache|storage|s3|r2|blob)/iu;
for (const dependency of Object.keys(serviceDependencies)) {
  if (forbiddenServiceDependencies.test(dependency)) throw new Error(`Feedback Serviceに永続化依存が混入しています: ${dependency}`);
}
NODE

node <<'NODE'
const fs = require("node:fs");
const yaml = require("js-yaml");
const document = yaml.load(fs.readFileSync("contracts/feedback/feedback-gateway.openapi.yaml", "utf8"));
const operations = [];
for (const pathItem of Object.values(document.paths || {})) {
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    if (pathItem[method]) operations.push(pathItem[method]);
  }
}
const operationIds = operations.map((operation) => operation.operationId);
const contractOperations = operations.map((operation) => operation["x-feedback-operation"]);
if (new Set(operationIds).size !== operationIds.length || new Set(contractOperations).size !== contractOperations.length) {
  throw new Error("operationIdまたはx-feedback-operationが一意ではありません");
}
const participantIssuance = operations.find((operation) => operation.operationId === "createFeedbackParticipant");
if (!participantIssuance || participantIssuance["x-feedback-permission"] !== undefined ||
    participantIssuance["x-feedback-authorization-mode"] !== "public-profile") {
  throw new Error("participant発行のpublic-profile専用境界がありません");
}
if (operations.some((operation) => operation !== participantIssuance && !operation["x-feedback-permission"])) {
  throw new Error("x-feedback-permissionがないoperationがあります");
}
const expectedVocabulary = [
  "feedback:read",
  "feedback:create",
  "feedback:reply",
  "feedback:revise",
  "feedback:attachment:read",
  "feedback:attachment:upload"
];
const actualVocabulary = document.components.schemas.Operation.enum;
if (JSON.stringify(actualVocabulary) !== JSON.stringify(expectedVocabulary)) {
  throw new Error("認可operation語彙がADR 0001と一致しません");
}
const capabilities = document.components.schemas.Capabilities;
if (!capabilities.required?.includes("discovery") || !capabilities.properties?.discovery) {
  throw new Error("workspace／resource discovery capabilityが公開profileにありません");
}
const upload = operations.find((operation) => operation.operationId === "uploadFeedbackAttachment");
if (upload?.["x-feedback-permission"] !== "feedback:attachment:upload") {
  throw new Error("attachment uploadの独立権限がありません");
}
const uploadProperties = upload?.requestBody?.content?.["multipart/form-data"]?.schema?.properties || {};
if (!uploadProperties.command || !uploadProperties.file) throw new Error("uploadはJSON commandとbinary partが必要です");
for (const operationId of ["createFeedbackThread", "replyFeedbackThread", "appendFeedbackRevision", "uploadFeedbackAttachment"]) {
  const operation = operations.find((value) => value.operationId === operationId);
  if (!operation?.responses?.["202"]) throw new Error(`結果不明のtyped recovery responseがありません: ${operationId}`);
}
if (document.components.schemas.ProviderRef) throw new Error("ProviderRefをbrowser OpenAPIへ公開しています");
NODE

pure_generic_paths=(
  packages/feedback-client
  packages/feedback-connector-sdk
  packages/feedback-envelope
  packages/feedback-gateway
  packages/feedback-controller
)
if rg -n "from ['\"](?:react|react-dom|@geibee/feedback-redmine|@geibee/feedback-connector-(?:redmine|jira-cloud))|document\\.|window\\.|HTMLElement|CustomElementRegistry" \
    "${pure_generic_paths[@]/%//src}"; then
  fail "pure generic packageへprovider、React、DOM依存が混入しています"
fi

browser_contract_paths=(
  contracts/feedback/feedback-gateway.openapi.yaml
  contracts/feedback/src/feedback-gateway.generated.ts
  contracts/feedback/src/v2.ts
  packages/feedback-client/src
  packages/feedback-controller/src
  packages/feedback-web-component/src
  packages/feedback-react/src
)
if rg -n '\b(ProviderRef|providerKey|objectId|canonicalUrl|issueId|journalId|redmineUrl|jiraKey|providerUrl)\b' "${browser_contract_paths[@]}"; then
  fail "browser契約へprovider内部参照が混入しています"
fi
if rg -n "@geibee/feedback-(?:connector-sdk|gateway|envelope|connector-redmine|connector-jira-cloud)" \
    packages/feedback-client/src packages/feedback-controller/src packages/feedback-web-component/src packages/feedback-react/src; then
  fail "browser packageがserver packageへ依存しています"
fi

if rg -n "from ['\"](?:node:sqlite|pg|mysql|redis|bull|kafkajs|amqplib)|writeFile|mkdir|createWriteStream|\.cache|uploadDirectory" apps/feedback-service/src; then
  fail "Feedback Service skeletonにDB、queue、cache、upload storage実装が混入しています"
fi

while IFS= read -r -d '' fixture; do
  node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$fixture"
done < <(find contracts/feedback/fixtures/v2 -maxdepth 1 -type f -name '*.json' -print0)

bash scripts/check-feedback-common-contracts.sh

packages=(
  @geibee/feedback-contracts
  @geibee/feedback-envelope
  @geibee/feedback-client
  @geibee/feedback-connector-sdk
  @geibee/feedback-controller
  @geibee/feedback-gateway
  @geibee/feedback-connector-redmine
  @geibee/feedback-connector-jira-cloud
  @geibee/feedback-web-component
  @geibee/feedback-react
  @geibee/feedback-service
)
for package_name in "${packages[@]}"; do
  echo "[feedback-phase1-package] $package_name"
  npm --workspace "$package_name" run typecheck
  npm --workspace "$package_name" run test
  npm --workspace "$package_name" run build
done

if rg -n '\b(ProviderRef|providerKey|objectId|canonicalUrl|issueId|journalId|redmineUrl|jiraKey|providerUrl)\b' \
    contracts/feedback/dist/v2.d.ts packages/feedback-client/dist packages/feedback-controller/dist \
    packages/feedback-web-component/dist packages/feedback-react/dist; then
  fail "build後のbrowser public declarationへprovider内部参照が混入しています"
fi

node --input-type=module <<'NODE'
const contracts = await import("@geibee/feedback-contracts/v2");
const repository = await import("@geibee/feedback-connector-sdk");
const envelope = await import("@geibee/feedback-envelope");
const gateway = await import("@geibee/feedback-gateway");
const controller = await import("@geibee/feedback-controller");
const webComponent = await import("@geibee/feedback-web-component");
const react = await import("@geibee/feedback-react");
const redmine = await import("@geibee/feedback-connector-redmine");
const jira = await import("@geibee/feedback-connector-jira-cloud");
if (contracts.feedbackContractVersion !== "2") throw new Error("v2 contracts exportが不正です");
if (repository.feedbackRepositoryContractVersion !== "2-alpha.1") throw new Error("repository exportが不正です");
if (envelope.feedbackEnvelopeDomainSeparator !== "feedback-envelope\n2\n") throw new Error("Envelope exportが不正です");
if (gateway.feedbackAuthorizationModes.length !== 3) throw new Error("gateway exportが不正です");
if (controller.default !== undefined) throw new Error("controllerへ未契約default exportが混入しています");
if (webComponent.feedbackWebComponentContractVersion !== "2" || react.feedbackReactContractVersion !== "2") {
  throw new Error("renderer exportが不正です");
}
if (redmine.feedbackRedmineConnectorKey !== "redmine" || jira.feedbackJiraCloudConnectorKey !== "jira-cloud") {
  throw new Error("Connector exportが不正です");
}
NODE

npm ls --workspaces --depth=0 >/dev/null

echo "[feedback-phase1] PASS"
