# Release手順

この文書はrelease担当者向けです。通常のreleaseはGitHub Actionsから行い、ローカルのpublish scriptは障害復旧時だけ使用します。Redmine npm／OCIに加え、Feedback Service runtime OCIを同じmonorepo versionで扱います。

`1.0.0-rc.1`は障害復旧時にローカルのstale `dist`が一部npmjs artifactへ混入したため使用しない。公開対象`dist`をclean buildする`1.0.0-rc.2`以降を使用する。

## 1. versionを更新する

releaseするversionを決め、rootと全workspaceへ同じ値を設定します。

```bash
export FEEDBACK_RELEASE_VERSION='1.0.0-rc.2'
npm version "${FEEDBACK_RELEASE_VERSION}" \
  --workspaces \
  --include-workspace-root \
  --no-git-tag-version
```

変更した契約とpackageの`CHANGELOG.md`を更新し、version変更をPRでmainへmergeします。
PRでは`.github/workflows/verify-feedback.yml`がskip指定なしの正規品質ゲートを実行し、branch rulesの`verify 結果集約`と`nightly 結果集約`を更新します。後者は独立した検証の代替ではなく、同じ正規品質ゲートの完了状態を集約する必須contextです。いずれかが未起動、skip、失敗のPRはmergeしません。定時実行でも同じ正規品質ゲートを再実行します。

## 2. 品質ゲートを通す

alpha.3候補では先に承認済みtest tenantで下記live Gateを実行し、成功出力だけを対応するfixtureへ反映してから正規verifyを実行する。Jira／Backlog Stage Bの証跡は共通の`threadReference`経路を含む必要がある。Backlog Stage Aもdigestが不一致なら再実行する。version・lockfile・対象sourceを変更した後はlive証跡を再取得する。

Backlogの検索件数が一件でも全体の一意性は保証しない。Stage Bは実際の回収呼出しで観測した件数と結果を照合し、別issueを作った状態で固定参照の操作先が分離されることを追加検証する。古い証跡のbooleanやdigestを手編集してGateを通さない。

skip変数を設定せずに実行します。

```bash
bash scripts/verify-feedback.sh
```

最後に`[feedback-verify] PASS`が出ないreleaseは公開しません。

Feedback Service／Jira Connectorをreleaseする場合は、同じrelease候補sourceで管理Jira Cloud開発site向けの`bash scripts/check-feedback-phase5-live.sh`も実行する。正規verify内の保存済みevidence検査は外部writeを再実行しないため、明示live Gateの代用にはならない。run-owned issueのcleanup成功と、出力`implementationDigest`が保存済みevidenceおよび現sourceに一致することを確認する。

Backlog Connectorを含むFeedback Service runtimeをreleaseする場合は、同じrelease候補sourceで`bash scripts/check-feedback-backlog-live.sh`を実行する。create／reply／append-only revisionの回収、別process再構築、attachmentの`unsupported`境界、全run-owned issueのcleanupを確認する。API keyは`FEEDBACK_BACKLOG_ACCEPTANCE_CREDENTIAL_FIFO`から一回だけ渡す方法を推奨する。

release候補をローカルで確認したい場合だけ、空directoryを指定して生成します。Node.js、npm、Docker Buildx、Trivy、jq、tar、`sha256sum`が必要です。

Redmine browser releaseにはv1互換packageに加え、`@geibee/feedback-redmine-react`のv2互換exportが参照する`@geibee/feedback-client`、`@geibee/feedback-controller`、`@geibee/feedback-react`を依存順で含めます。標準`@geibee/feedback-web-component`、provider Connector、Feedback Service runtimeはPhase 5で統合検証するが、このRedmine npm／OCI release集合へ暗黙に含めません。Feedback Service runtimeは[`docs/phase5/deployment.md`](./phase5/deployment.md)の独立deploy手順を使います。

```bash
mkdir "/tmp/feedback-redmine-${FEEDBACK_RELEASE_VERSION}"
bash scripts/build-feedback-redmine-release.sh \
  --output "/tmp/feedback-redmine-${FEEDBACK_RELEASE_VERSION}" \
  --version "${FEEDBACK_RELEASE_VERSION}"

cd "/tmp/feedback-redmine-${FEEDBACK_RELEASE_VERSION}"
sha256sum --check SHA256SUMS
jq '{version, packages: [.packages[].name], images: [.images[] | {name, indexDigest, platforms}]}' \
  release-manifest.json
```

Backlogを含むFeedback Service runtime候補は別の空directoryへ生成します。

```bash
mkdir "/tmp/feedback-service-${FEEDBACK_RELEASE_VERSION}"
bash scripts/build-feedback-service-release.sh \
  --output "/tmp/feedback-service-${FEEDBACK_RELEASE_VERSION}" \
  --version "${FEEDBACK_RELEASE_VERSION}"

cd "/tmp/feedback-service-${FEEDBACK_RELEASE_VERSION}"
sha256sum --check feedback-service-SHA256SUMS
jq '{version, contractVersion, providers: .runtime.providers, backlogCapabilities, images: [.images[] | {name, indexDigest, platforms}]}' \
  feedback-service-release-manifest.json
```

出力先が既に存在して中身がある場合、builderは停止します。別の空directoryを使ってください。
release manifestの`sourceTreeState`が`dirty`の候補は内容確認専用です。publisherはfail-closedで拒否するため、公開workflowではcleanなtag checkoutから再生成します。
builderは公開対象workspaceの`dist`をbuild前に削除する。障害復旧時も既存のローカルbuild出力を再利用せず、必ず同じtagからbuilderを再実行してnpmjs用artifactを生成する。GitHub Releaseへ添付されたnpm tarballはGitHub Packages用であり、npmjsへの代用はしない。

## 3. tagをpushする

mainのversion commitへ`v`付きtagを作ります。

```bash
git switch main
git pull --ff-only origin main
git tag -a "v${FEEDBACK_RELEASE_VERSION}" -m "Feedback Redmine ${FEEDBACK_RELEASE_VERSION}"
git push origin "v${FEEDBACK_RELEASE_VERSION}"
```

`.github/workflows/release-feedback-redmine.yml`が次を自動実行します。

1. tagと全packageのversion一致を確認する。
2. `bash scripts/verify-feedback.sh`を実行する。
3. Redmine npm tarball／OCIと、Backlog Connectorを含むFeedback Service runtime OCI、SBOM、脆弱性report、各manifest／checksumを生成する。
4. GitHub Release draftへartifactを添付する。
5. npm trusted publishing（GitHub OIDC）でnpmjsへ公開する。
6. GitHub PackagesとGHCRへRedmine artifactを公開し、Feedback Service runtimeを独立したGHCR imageとして公開する。
7. GitHub Releaseを公開する。

`release` environmentの承認画面では、version、変更内容、未修正のHIGH/CRITICAL脆弱性がある場合の判断を確認します。tagを作り直したり、同じversionへ異なるartifactを手動publishしたりしないでください。

## 4. 公開結果を確認する

```bash
gh run list --workflow release-feedback-redmine.yml --limit 1
gh release download "v${FEEDBACK_RELEASE_VERSION}" \
  --dir "/tmp/feedback-redmine-release-check-${FEEDBACK_RELEASE_VERSION}"

cd "/tmp/feedback-redmine-release-check-${FEEDBACK_RELEASE_VERSION}"
sha256sum --check SHA256SUMS
jq -r '.images[] | [.name, .indexDigest] | @tsv' release-manifest.json
```

npmjs packageを匿名で取得できることと、gateway imageをmanifest記載のdigestで取得できることも確認します。配備時はtagではなく、次の形式でdigestを固定します。

```text
ghcr.io/geibee/feedback-redmine-gateway@sha256:<release-manifestのindexDigest>
```

## npmjsだけへ手動公開する場合

GitHub Packages／GHCRを使わずnpmjsだけへ公開する承認済み作業では、`--npm-only`を付けます。このmodeではOCI imageを生成・公開しません。

```bash
npm whoami --registry=https://registry.npmjs.org

mkdir "/tmp/feedback-redmine-npm-${FEEDBACK_RELEASE_VERSION}"
bash scripts/build-feedback-redmine-release.sh \
  --output "/tmp/feedback-redmine-npm-${FEEDBACK_RELEASE_VERSION}" \
  --version "${FEEDBACK_RELEASE_VERSION}" \
  --npm-only

bash scripts/publish-feedback-redmine-release.sh \
  --input "/tmp/feedback-redmine-npm-${FEEDBACK_RELEASE_VERSION}" \
  --version "${FEEDBACK_RELEASE_VERSION}" \
  --npm-only \
  --tag next
```
