# Feedback System

React SPAへ画面内フィードバックを追加するためのSDKと、独立したFeedback Service、
Admin Consoleを提供します。

ホストアプリのrouter・認証・業務DBを所有せず、コメント、画面上のpin、証跡、
返信、解決管理などのフィードバック機能だけを分離して導入できます。

> 現在のバージョンは `1.0.0-alpha.1` です。
> npm packageはregistry公開前のため、リポジトリ内のworkspaceまたは
> `npm pack`で生成したtarballから利用します。

## 主な機能

- React 18 / 19向けのコメントOverlay、DOM／画面座標pin、Thread Drawer
- レビューセッション、確認観点、返信、解決状態の管理
- 画像などの証跡をprivate object storageへ保存
- メンバー、通知、保存期間、CSV／XLSX exportを扱うAdmin Console
- OIDC Bearer JWT、またはmTLS token exchangeによる認証
- 任意のMapLibre連携

Feedback Serviceに障害が発生した場合はFeedback UIだけを縮退させ、
ホストアプリ全体の表示や操作は継続できます。

## 構成

```text
React SPA ── Feedback SDK ─────────────┐
                                       │
Admin Console ─────────────────────────┼── Feedback Service
                                       │      ├── PostgreSQL
OIDC Provider ── Bearer JWT ───────────┤      └── private object storage
                                       │
Host backend ── mTLS token exchange ───┘
```

Feedback Serviceはホストアプリの業務DBを参照しません。
ホスト側のprojectやworkspaceは、Feedback側のexternalWorkspaceKeyとして対応付けます。

## ローカルで起動する

必要なもの:

- Docker Engine
- Docker Compose v2
- 初回build時のネットワーク接続

```bash
cp deploy/.env.example deploy/.env

docker compose \
  --env-file deploy/.env \
  -f deploy/compose.yaml \
  up -d --build
```

起動確認:

```bash
curl --fail http://localhost:8090/health/ready

docker compose \
  --env-file deploy/.env \
  -f deploy/compose.yaml \
  ps
```

主なURL:

| URL | 用途 |
| --- | --- |
| <http://localhost:5174> | Admin Console |
| <http://localhost:5175> | consumer適合性fixture |
| <http://localhost:8090/feedback/v1> | Feedback API v1 |
| <http://localhost:8090/health/ready> | API readiness |
| <http://localhost:8180> | ローカルOIDC Provider |

Admin Consoleのローカルユーザー:

```text
ユーザー名: feedback-admin
パスワード: feedback-local-only
```

`deploy/.env.example`のcredentialはローカル専用です。本番環境には使用しないでください。

停止:

```bash
docker compose \
  --env-file deploy/.env \
  -f deploy/compose.yaml \
  down
```

`down --volumes`はPostgreSQL、証跡、exportを含むローカルデータを削除します。

詳しい起動方法は[`docs/quickstart.md`](docs/quickstart.md)を参照してください。

## ホストアプリへ組み込む

導入は次の単位に分かれます。

1. Feedback Service用のPostgreSQLを用意する（`full` profileではprivate object storageも用意する）
2. OIDCまたはtoken exchangeを設定する
3. installation manifestでtenant、application、environment、workspace、membershipを同期する
4. ホストアプリへFeedback SDKを追加する
5. `FeedbackHostAdapter`でrouter、token、workspace、画面遷移を接続する
6. `feedback manifest apply`でapplication manifestをCI/CDから同期する
7. `FeedbackProvider`と`FeedbackOverlay`を配置する

Reactの最小構成:

```tsx
import {
  FeedbackErrorBoundary,
  FeedbackOverlay,
  FeedbackProvider
} from "@feedback/react";
import "@feedback/react/styles.css";

<FeedbackErrorBoundary>
  <FeedbackProvider adapter={adapter} transport={transport}>
    <FeedbackOverlay />
  </FeedbackProvider>
</FeedbackErrorBoundary>;
```

SDKは次の情報をホストアプリから受け取ります。

- `applicationKey`
- `environmentKey`
- `externalWorkspaceKey`
- 現在のrouteと画面parameters
- route／workspace変更通知（SPAでは任意の`HostAdapter.subscribe`で接続）
- Feedback audienceを持つaccess token
- deep linkの画面遷移処理

詳しい実装は[`docs/react-integration.md`](docs/react-integration.md)を参照してください。
resourceとmanifestの導入手順、v1のtenant境界は[`docs/installation.md`](docs/installation.md)を参照してください。

### ブラウザ設定

別originのFeedback Serviceへ接続する場合は、次の設定も必要です。

- Feedback Serviceのallowed originsへホストアプリのoriginを登録する
- ホストアプリのCSP `connect-src`へFeedback APIのoriginを追加する
- 証跡previewを使用する場合はCSP `img-src blob:`を許可する
- Feedback APIのoriginを`frame-src`へ追加しない
- cross-origin画像やfontを証跡へ含める場合は、対象リソースのCORSを設定する

### 認証と認可

直接OIDCを使う場合、JWTにはFeedback Serviceが検証するissuerとaudienceが必要です。

ホストアプリの権限とFeedbackのmembershipは別に管理されます。Feedback Serviceの実効権限は、
tokenに含まれるpermissionとFeedback DBのmembershipの積集合です。

詳細は[`docs/authentication.md`](docs/authentication.md)を参照してください。

実際の組み込み例として
[`geibee/gis-example`](https://github.com/geibee/gis-example)も参照できます。

## 開発

SDKやServiceを変更する場合は、Node.js 22以上25未満、npm、Go 1.26.5が必要です。

```bash
npm ci
bash scripts/verify-feedback.sh
```

標準品質ゲートは、Goとnpm workspaceのbuild／test、契約drift、
package consumer適合性、Compose構成を検査します。

standalone構成の全経路を確認する場合:

```bash
bash scripts/smoke-feedback-standalone.sh
```

このスクリプトは専用のcontainerとvolumeを作成し、終了時に削除します。

## 公開契約

- REST API: [`contracts/feedback/openapi.yaml`](contracts/feedback/openapi.yaml)
- JSON Schema: [`contracts/feedback/schemas`](contracts/feedback/schemas)
- npm packages: `@feedback/contracts`、`@feedback/core`、`@feedback/react`
- 任意package: `@feedback/maplibre`、`@feedback/admin-react`
- DB migration: [`apps/feedback-service-go/migrations`](apps/feedback-service-go/migrations)

`/feedback/v1`と`@feedback/*` 1.xは後方互換を維持します。
ServiceとSDKは対応するversionを揃えて更新してください。

## ドキュメント

| 内容 | ドキュメント |
| --- | --- |
| 起動とmigration | [`docs/quickstart.md`](docs/quickstart.md) |
| React SPAへの組み込み | [`docs/react-integration.md`](docs/react-integration.md) |
| OIDCとtoken exchange | [`docs/authentication.md`](docs/authentication.md) |
| 環境変数 | [`docs/environment-variables.md`](docs/environment-variables.md) |
| 運用、health、storage、旧環境移行 | [`docs/operations.md`](docs/operations.md) |
| backupと通知connector | [`docs/backup-and-connectors.md`](docs/backup-and-connectors.md) |
| API／SDK互換性 | [`docs/api-compatibility.md`](docs/api-compatibility.md) |
| upgradeとrollback | [`docs/upgrade.md`](docs/upgrade.md) |
| release artifact | [`docs/release.md`](docs/release.md) |
| Azure Container Appsへの配備 | [`docs/azure-deployment.md`](docs/azure-deployment.md) |

## License

[MIT License](LICENSE)
