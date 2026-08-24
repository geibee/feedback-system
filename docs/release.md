# Release手順

この文書はrelease担当者向けです。通常のreleaseはGitHub Actionsから行い、ローカルのpublish scriptは障害復旧時だけ使用します。

## 1. versionを更新する

releaseするversionを決め、rootと全workspaceへ同じ値を設定します。

```bash
export FEEDBACK_RELEASE_VERSION='1.0.0-rc.1'
npm version "${FEEDBACK_RELEASE_VERSION}" \
  --workspaces \
  --include-workspace-root \
  --no-git-tag-version
```

変更した契約とpackageの`CHANGELOG.md`を更新し、version変更をPRでmainへmergeします。

## 2. 品質ゲートを通す

skip変数を設定せずに実行します。

```bash
bash scripts/verify-feedback.sh
```

最後に`[feedback-verify] PASS`が出ないreleaseは公開しません。

release候補をローカルで確認したい場合だけ、空directoryを指定して生成します。Node.js、npm、Docker Buildx、Trivy、jq、tar、`sha256sum`が必要です。

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

出力先が既に存在して中身がある場合、builderは停止します。別の空directoryを使ってください。

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
3. npm tarball、multi-architecture OCI image、SBOM、脆弱性report、`release-manifest.json`、`SHA256SUMS`を生成する。
4. GitHub Release draftへartifactを添付する。
5. GitHub PackagesとGHCRへ公開する。
6. GitHub Releaseを公開する。

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

packageを匿名で取得できることと、gateway imageをmanifest記載のdigestで取得できることも確認します。配備時はtagではなく、次の形式でdigestを固定します。

```text
ghcr.io/geibee/feedback-redmine-gateway@sha256:<release-manifestのindexDigest>
```

## npmjsだけへ公開する場合

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

## Legacy artifactを検証する場合

新規導入には使いません。Legacy Feedback Serviceを保守するときだけ生成します。

```bash
bash scripts/build-feedback-sdk-release.sh \
  --output /tmp/feedback-sdk-release \
  --version "${FEEDBACK_RELEASE_VERSION}"

bash scripts/build-feedback-go-release.sh \
  --output /tmp/feedback-go-release \
  --version "${FEEDBACK_RELEASE_VERSION}"
```
