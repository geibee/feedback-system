# Release artifact

## Redmine正本SPA（標準）

空directoryを指定し、同一versionへ固定したpublish可能なtarball一式を生成する。

```bash
bash scripts/build-feedback-redmine-release.sh \
  --output /tmp/feedback-redmine-release \
  --version 1.0.0-rc.1
```

生成物:

- `@geibee/feedback-contracts`
- `@geibee/feedback-core`
- `@geibee/feedback-dom-capture`
- `@geibee/feedback-react-ui`
- `@geibee/feedback-maplibre`
- `@geibee/feedback-redmine-core`
- `@geibee/feedback-redmine-react`
- `@geibee/feedback-redmine-plugin`
- `@geibee/feedback-redmine-gateway`
- `@geibee/feedback-redmine-ops`
- linux/amd64・linux/arm64の`feedback-redmine-gateway` OCI archive
- linux/amd64・linux/arm64のローカル評価用`feedback-redmine-demo` OCI archive
- imageごと・platformごとのCycloneDX SBOMとHIGH/CRITICAL vulnerability SARIF
- publish順を持つ`release-manifest.json`と`SHA256SUMS`

release builderはstaging copyだけから`private`を除去し、内部`@geibee/*`依存を指定versionへ固定する。source workspaceは
変更せず、publishやOCI pushも行わない。tarballは`https://npm.pkg.github.com`、imageは
`ghcr.io/geibee/feedback-redmine-gateway`と`ghcr.io/geibee/feedback-redmine-demo`を正規公開先とする。
全HIGH/CRITICALをSARIFへ記録し、vendor修正版がある
HIGH/CRITICALを検出した場合はrelease生成を失敗させる。修正版がない検出結果はrisk acceptance対象としてrelease reviewで判断する。

ブラウザ拡張ZIPとReact runtime入りself-hosted bundleは標準releaseへ含めない。React 18/19はconsumer SPAのpeer dependencyを使う。
`apps/feedback-redmine-gateway-reference`は標準gateway imageのsourceである。

npmjsだけへ初回公開する場合は`--npm-only`でOCI生成を省略する。このmodeのtarballは
`https://registry.npmjs.org`を公開先に持ち、公開scriptはGHCRへアクセスしない。

```bash
bash scripts/build-feedback-redmine-release.sh \
  --output /tmp/feedback-redmine-npm-release \
  --version 1.0.0-alpha.4 \
  --npm-only

bash scripts/publish-feedback-redmine-release.sh \
  --input /tmp/feedback-redmine-npm-release \
  --version 1.0.0-alpha.4 \
  --npm-only \
  --tag next
```

初回公開前に`npm whoami --registry=https://registry.npmjs.org`が`geibee`を返すことを確認する。公開scriptは
同じversionが存在する場合にintegrityが一致すれば再利用し、不一致なら停止する。
npmjsはpackage metadataに`latest`を必須とするため、新規packageの初回公開では`--tag next`でも`latest`が同じversionへ
自動設定される。consumer手順ではプレリリースであることを明示するため、引き続き`@next`を指定する。

release前にskip変数なしの`bash scripts/verify-feedback.sh`を実行し、次をすべて通す。

- cleanなReact 18/19 + Vite 8.2 tarball consumer
- controllerのdisable/re-enable/destroy/purge browser lifecycle
- browser bundleのsource map、dynamic code、test credential、remote script scan
- gatewayのnon-root/read-only container probe
- local Compose、provisioner、runtime config、ops CLI
- Redmine 5.1.12、6.0.10、6.1.3、7.0.0のdigest固定conformance

`v<package.jsonのversion>` tagをpushすると`.github/workflows/release-feedback-redmine.yml`が正規品質ゲート、release候補生成、
GitHub Release draftと全assetの準備、GitHub Packages・GHCR公開、draft公開をこの順で実行する。suffix付きversionだけを
prereleaseにし、stable versionは通常releaseにする。途中失敗後は同じintegrity/digestの公開済みartifactとdraftを再利用し、
異なる内容が同じversion/tagに存在する場合は停止する。

repositoryではimmutable releasesを有効にし、`release` environmentへ承認規則を設定する。GitHub PackagesとGHCRのwrite権限は
このrepositoryのrelease workflowだけに付与し、同じversion/tagへの手動publishを許可しない。GHCRのversion tagは探索用であり、
配備時はGitHub Releaseの`release-manifest.json`に記録された`indexDigest`を使って
`ghcr.io/geibee/<image>@sha256:...`の形式で固定する。初回公開後にrepository ownerがGitHubのpackage設定でnpm packageと
container packageをpublicへ設定し、匿名consumerが取得できることを確認する。以後もvisibilityとdigestをrelease reviewで確認する。

障害復旧でローカルから公開scriptを実行する場合はworkflowを停止し、単一writerであることを確認してから、package write権限を持つ
`NODE_AUTH_TOKEN`と`GITHUB_TOKEN`、`GITHUB_ACTOR`を環境から注入する。tokenを`.npmrc`、shell引数、repositoryへ保存しない。

```bash
bash scripts/publish-feedback-redmine-release.sh \
  --input /tmp/feedback-redmine-release \
  --version 1.0.0-rc.1
```

生成後は`SHA256SUMS`と署名を検証する。

## Legacy Feedback Service SDK

> **Legacy Feedback Service:** PostgreSQLとobject storageを使う従来runtime向けで、新規導入の標準artifactではない。

```bash
bash scripts/build-feedback-sdk-release.sh \
  --output /tmp/feedback-sdk-release \
  --version 1.0.0-rc.1
```

`@geibee/feedback-contracts`、`@geibee/feedback-core`、`@geibee/feedback-react-ui`、`@geibee/react`、`@geibee/feedback-maplibre`、`@geibee/admin-react`のtarball、
`release-manifest.json`、`SHA256SUMS`を生成する。

## Legacy Go Service・CLI

> **Legacy Feedback Service:** DB migration、worker、Admin Consoleを含む従来runtime専用である。

```bash
bash scripts/build-feedback-go-release.sh \
  --output /tmp/feedback-go-release \
  --version 1.0.0-rc.1
```

server用linux/amd64・linux/arm64静的binary、CLI用artifact、multi-arch OCI archive、CycloneDX SBOM、vulnerability scan SARIF、
manifest、checksumを生成する。runtimeはUID/GID 65532のdistroless static imageで、shellとpackage managerを含めない。
release生成はGo 1.26.5とTrivy 0.70.0を要求する。

本番投入済みの旧runtimeは存在しないため、Redmine releaseに移行CLI、dual-write tool、rollback用データ変換artifactは含めない。
