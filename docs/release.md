# Release artifact

## Redmine正本SPA（標準）

空directoryを指定し、同一versionへ固定したpublish可能なtarball一式を生成する。

```bash
bash scripts/build-feedback-redmine-release.sh \
  --output /tmp/feedback-redmine-release \
  --version 1.0.0-rc.1
```

生成物:

- `@feedback/contracts`
- `@feedback/core`
- `@feedback/dom-capture`
- `@feedback/react-ui`
- `@feedback/maplibre`
- `@feedback/redmine-core`
- `@feedback/redmine-react`
- `@feedback/redmine-plugin`
- `@feedback/redmine-gateway`
- publish順を持つ`release-manifest.json`と`SHA256SUMS`

release builderはstaging copyだけから`private`を除去し、内部`@feedback/*`依存を指定versionへ固定する。source workspaceは
変更せず、publishやOCI pushも行わない。`release-manifest.json`の`publishOrder`順に承認済みnpm互換registryへ投入する。

ブラウザ拡張ZIP、React runtime入りself-hosted bundle、reference gateway imageは標準releaseへ含めない。React 18/19は
consumer SPAのpeer dependencyを使う。`apps/feedback-redmine-gateway-reference`は公開participant modeのローカル確認用sourceで、
本番artifactではない。

release前にskip変数なしの`bash scripts/verify-feedback.sh`を実行し、次をすべて通す。

- cleanなReact 18/19 + Vite tarball consumer
- controllerのdisable/re-enable/destroy/purge browser lifecycle
- browser bundleのsource map、dynamic code、test credential、remote script scan
- gatewayのnon-root/read-only container probe
- Redmine 5.1.12、6.0.10、6.1.3、7.0.0のdigest固定conformance

registry credentialは環境またはuser-level npm設定から注入し、repositoryへ保存しない。生成後は`SHA256SUMS`と署名を検証する。

## Legacy Feedback Service SDK

> **Legacy Feedback Service:** PostgreSQLとobject storageを使う従来runtime向けで、新規導入の標準artifactではない。

```bash
bash scripts/build-feedback-sdk-release.sh \
  --output /tmp/feedback-sdk-release \
  --version 1.0.0-rc.1
```

`@feedback/contracts`、`@feedback/core`、`@feedback/react-ui`、`@feedback/react`、`@feedback/maplibre`、`@feedback/admin-react`のtarball、
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
