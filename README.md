# Feedback System

React SPAへ画面内フィードバックを追加し、Redmineのissue、journal、attachment、custom fieldを唯一の業務データ正本として使う
pluginとsame-origin gatewayです。Feedback専用DBやobject storageを新設せず、利用者はSPA内で投稿と返信を行えます。

現在のsource versionは`1.0.0-alpha.3`です。

## まず試す

目的ごとに入口を分けています。手順を混ぜず、どちらか一方を選んでください。

| 目的 | 入口 |
| --- | --- |
| repositoryのデモをローカル評価する | 下記の「source checkout」 |
| GitHub Packagesから既存SPAへ組み込む | [`docs/quickstart.md`](docs/quickstart.md) |
| 既存Redmineへ本番導入する | [`docs/feedback-redmine-installation.md`](docs/feedback-redmine-installation.md) |

### source checkoutでローカル評価する

Node.js 22.12以上25未満、npm、Docker Engine、Docker Compose v2が必要です。

```bash
npm ci
npm run feedback:redmine:local
```

起動後のFeedbackデモは`http://127.0.0.1:4173`、Redmine管理画面は`http://127.0.0.1:3001`です。
Redmineのランダム生成password確認と停止は次のコマンドで行います。

```bash
node packages/feedback-redmine-ops/dist/cli.js local credentials
node packages/feedback-redmine-ops/dist/cli.js local down
```

このローカル環境は専用Redmineを作成します。顧客または既存のRedmineへこのbootstrapを実行しないでください。

### GitHub PackagesからSPAへ組み込む

packageを公開済みのversionから導入します。`.npmrc`にはtoken値ではなく環境変数参照だけを保存します。

```ini
@geibee:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

```bash
npm install @geibee/redmine-plugin@1.0.0-alpha.3
```

`NODE_AUTH_TOKEN`は`read:packages`権限を持つpersonal access token（classic）としてshellまたはCI secretから注入します。
完全なHost Adapter、runtime config、React cleanupを含むコピー可能な例は[`docs/quickstart.md`](docs/quickstart.md)にあります。

## 標準構成

```text
React SPA
  └─ @geibee/redmine-plugin/loader
       │  配備時runtime configでdynamic import / unmount
       ▼
same-origin /internal/feedback-redmine/v1
  └─ @geibee/redmine-gateway
       │  Origin/Fetch Metadata・participant credential
       │  server-side integration API key
       ▼
Redmine
  ├─ issue + 11 custom fields
  ├─ journal
  └─ context / evidence attachment
```

gatewayはstatelessで、DB、queue、cache、filesystem upload、object storageを持ちません。Redmine API key、Redmine URL、
participant署名鍵はserver-side secretだけから注入し、browserへ渡しません。React 18または19はSPAとpeer dependencyとして共有します。

`/.well-known/feedback-redmine.json`の`enabled`を変更できるため、SPAを再buildせず有効化・無効化できます。
`enabled:false`ではDOM、gateway通信、timer、router購読を開始しません。DOM画面だけの導入にMapLibreやcustom target設定は不要です。

公開participant modeでは、同じoriginへ到達できる利用者が同じProfileの投稿を閲覧、作成、返信できます。
Origin検査とparticipant credentialは実在人物の認証ではありません。公開範囲を限定する環境では、gatewayの外側へアクセス制御を追加します。

## Redmineへ導入する

既存Redmineへの導入は次のいずれかです。

- Rails runnerを利用できる環境: plan、digest確認、明示的apply
- managed Redmine: 管理画面で設定し、REST inspectと手動確認digestで検証
- 必要な管理権限を取得できない環境: 非対応

11 custom fields、専用project、tracker、integration user、role、status、workflowを含む手順は
[`docs/feedback-redmine-installation.md`](docs/feedback-redmine-installation.md)を参照してください。

## 開発と検証

標準Redmine経路だけを変更するときは、次を実行します。

```bash
npm ci
npm run build
npm run test:redmine
```

release前の正規入口は次です。RedmineとLegacyの両方をskipなしで検証します。

```bash
bash scripts/verify-feedback.sh
```

未実行の検証を成功として扱いません。Redmine単独ゲートはGoやLegacy applicationを要求せず、正規入口は両ゲートを集約します。

## Releaseと公開契約

`v<version>`tagのrelease workflowは正規品質ゲート通過後に、npm packageをGitHub Packagesへ、gateway/demo imageをGHCRへ公開し、
tarball、OCI archive、SBOM、SARIF、manifest、`SHA256SUMS`をGitHub Releaseへ添付します。同じversionは上書きしません。
詳細は[`docs/release.md`](docs/release.md)を参照してください。

- Gateway OpenAPI: [`contracts/feedback/redmine-gateway.openapi.yaml`](contracts/feedback/redmine-gateway.openapi.yaml)
- JSON Schema: [`contracts/feedback/schemas`](contracts/feedback/schemas)
- API／package互換性: [`docs/api-compatibility.md`](docs/api-compatibility.md)

APIまたはDTOを変更するときは、OpenAPI、生成型、互換性文書を同じ変更で更新します。

## Legacy Feedback Service

PostgreSQL、private object storage、OIDC、Admin Consoleを使う従来Feedback Serviceは互換経路として維持しますが、
新規導入の標準ではありません。Legacyだけを評価・保守する場合は[`docs/legacy-quickstart.md`](docs/legacy-quickstart.md)を参照してください。

## ドキュメント

| 内容 | ドキュメント |
| --- | --- |
| SPA Quickstart | [`docs/quickstart.md`](docs/quickstart.md) |
| 導入・本番配備・backup・障害調査 | [`docs/feedback-redmine-installation.md`](docs/feedback-redmine-installation.md) |
| Redmine projectと11 custom fields | [`docs/redmine-integration.md`](docs/redmine-integration.md) |
| same-origin gateway | [`docs/redmine-gateway.md`](docs/redmine-gateway.md) |
| reverse proxy | [`docs/reverse-proxy.md`](docs/reverse-proxy.md) |
| 環境変数とsecret境界 | [`docs/environment-variables.md`](docs/environment-variables.md) |
| release artifact | [`docs/release.md`](docs/release.md) |
| Legacy runtime | [`docs/legacy-quickstart.md`](docs/legacy-quickstart.md) |

## License

[MIT License](LICENSE)
