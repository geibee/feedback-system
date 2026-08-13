# Release artifact

## SDK packages

Feedback SDKをregistryへ配布する前に、空directoryへpublish可能なtarball一式を生成する。repository内のworkspaceは
誤publish防止のため`private: true`を維持し、release builderだけがstaging copyから`private`を除去して同一versionの
内部依存へ固定する。

```bash
bash scripts/build-feedback-sdk-release.sh --output /tmp/feedback-sdk-release --version 1.0.0-rc.1
```

生成物は`@feedback/contracts`、`@feedback/core`、`@feedback/react`、`@feedback/maplibre`、
`@feedback/admin-react`のtarball、公開順を持つ`release-manifest.json`、`SHA256SUMS`である。
`bash scripts/verify-feedback.sh`成功後、checksumと署名を検証し、`release-manifest.json`の`publishOrder`順に
承認済みnpm互換registryへ投入する。例:

```bash
npm publish /tmp/feedback-sdk-release/feedback-contracts-1.0.0-rc.1.tgz \
  --registry https://registry.example.com --tag next
```

registry credentialは環境またはuser-level npm設定から注入し、repositoryへ保存しない。release script自体はpublishを行わない。

## Go Service・CLI

空directoryを指定してmulti-arch artifactを生成する。

```bash
bash scripts/build-feedback-go-release.sh --output /tmp/feedback-go-release --version 1.0.0-rc.1
```

server用linux/amd64・linux/arm64静的binary、CLI/ローカル検証用darwin/arm64・windows/amd64 binary、
multi-arch OCI archive、linux/amd64・linux/arm64別のCycloneDX SBOM、
HIGH/CRITICALでfailするplatform別OCI vulnerability scanのSARIF、`release-manifest.json`、`SHA256SUMS` を出力する。
publish処理は含まないため、registryへのpush前に
checksumを検証し、`release-manifest.json` と `SHA256SUMS` を署名する。

runtimeはUID/GID 65532のdistroless static imageであり、shellとpackage managerを含めない。静的binary、
CA証明書、timezone data、10 entrypointだけを実行境界とする。

darwin/windows artifactでは`<binary> backup-pull`または`<binary> legacy-migration ...`のようにsubcommandを指定する。
serverの本番保証対象はLinuxだけである。

repositoryはKotlin/JDK/Gradleを含まず、空DB用clean V1をGo binaryへ埋め込んだGo-only形状である。
`bash scripts/verify-feedback.sh`と`bash scripts/smoke-feedback-standalone.sh`をJDKなしで完走させてからartifactを生成する。
過去の稼働済みKotlin環境を移行する場合だけ、切替元image digestを別のrollback artifactとして保持する。
release生成はGo 1.26.5とTrivy 0.70.0を要求し、別versionではfail-closedに停止する。
