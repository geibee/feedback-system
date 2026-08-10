# Feedback System

React SPA に画面内フィードバックを組み込むための SDK、独立した Feedback Service、管理画面、
認証連携の参照実装をまとめたリポジトリです。ホストアプリの router・認証・業務 DB を所有せず、
フィードバック機能だけを独立して導入・運用できます。

現在のバージョンは `1.0.0-alpha.1` です。npm package は registry 公開前のため、現時点では
リポジトリ内の workspace または `npm pack` した tarball から利用します。

## できること

- React 18 / 19 の画面へコメント、画面座標 pin、DOM 要素 pin、返信、解決状態を追加する
- 画面定義（application manifest）とレビューセッションを使って、投稿対象と確認観点を管理する
- 画像などの証跡を private object storage に保存し、認可済み API からだけ取得する
- 管理画面からレビュー、メンバー、通知、保存期間、CSV / XLSX export を管理する
- 直接 OIDC、または mTLS token exchange を介した短寿命 JWT で認証する
- PostgreSQL と S3 互換 object storage だけで Feedback Service を独立運用する

Feedback Service が停止しても、SDK の Error Boundary によりホスト画面全体ではなく
Feedback subtree だけが縮退します。MapLibre 連携は任意 package で、通常の React 導入には不要です。

## 全体像

```text
React SPA ── @feedback/react ── @feedback/core ──┐
                                                 ├── Feedback Service ── PostgreSQL
Admin Console ── @feedback/admin-react ──────────┤                    └─ S3 / MinIO
                                                 │
OIDC Provider ───────────── Bearer JWT ──────────┤
Host backend ── mTLS ── token exchange broker ──┘
```

公開契約の正本は [`contracts/feedback`](contracts/feedback) にある OpenAPI と JSON Schema、
DB DDL の正本は [`apps/feedback-service-go/migrations`](apps/feedback-service-go/migrations) にある
Flyway migration です。

## リポジトリ構成

| パス | 役割 |
| --- | --- |
| [`apps/feedback-service-go`](apps/feedback-service-go) | Go 製 API、worker、migration / bootstrap / 運用 CLI |
| [`apps/feedback-admin`](apps/feedback-admin) | 独立 Admin Console SPA |
| [`apps/feedback-token-broker-reference`](apps/feedback-token-broker-reference) | mTLS token exchange の参照 broker |
| [`apps/feedback-conformance-consumer`](apps/feedback-conformance-consumer) | SDK と token exchange の適合性を確認する consumer fixture |
| [`contracts/feedback`](contracts/feedback) | OpenAPI、JSON Schema、生成型、互換性 freeze |
| [`packages/feedback-core`](packages/feedback-core) | UI framework に依存しない transport、HostAdapter、manifest 解決 |
| [`packages/feedback-react`](packages/feedback-react) | React Provider、Overlay、pin、証跡 capture |
| [`packages/feedback-maplibre`](packages/feedback-maplibre) | 任意の MapLibre pin 連携 |
| [`packages/feedback-admin-react`](packages/feedback-admin-react) | 管理 UI component |
| [`deploy`](deploy) | ローカル用 Compose、Keycloak、証明書、fixture 設定 |
| [`scripts`](scripts) | 品質ゲート、standalone smoke、release 作成、計測 |

## まずローカルで起動する

### 必要なもの

- Docker Engine と Docker Compose v2
- 初回の image build と npm / Go module 取得に使うネットワーク接続

SDK や Service を変更する場合は、追加で Node.js 22 以上 25 未満、npm、Go 1.26.5 が必要です。

### 起動

ローカル専用の設定例をコピーし、全 service を background で起動します。

```bash
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
```

API が ready になるまで待ってから、次のコマンドで確認できます。

```bash
curl --fail http://localhost:8090/health/ready
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
```

起動する主な endpoint は次のとおりです。すべて loopback interface にだけ公開されます。

| URL | 用途 |
| --- | --- |
| <http://localhost:5174> | Admin Console |
| <http://localhost:5175> | conformance consumer fixture |
| <http://localhost:8090/feedback/v1> | Feedback API v1 |
| <http://localhost:8090/health/ready> | API readiness |
| <http://localhost:8180> | ローカル Keycloak |
| <http://localhost:9001> | ローカル MinIO Console |

Admin Console の「ログインして管理を始める」から、次のローカル専用ユーザーでログインできます。

```text
ユーザー名: feedback-admin
パスワード: feedback-local-only
```

Compose の bootstrap は `local` tenant、`inventory` application、`local` environment、`east` / `west`
workspace と管理者 membership を作成します。application manifest とレビューセッションは導入先ごとに異なるため、
自動作成しません。Admin Console でレビューを作成する前に、導入する consumer の manifest を
`PUT /feedback/v1/applications/{applicationKey}/manifest` で登録してください。形式は
[`application-manifest.schema.json`](contracts/feedback/schemas/application-manifest.schema.json) と
[`openapi.yaml`](contracts/feedback/openapi.yaml) を参照してください。

管理画面の操作だけを試す場合は、`curl` と `jq` を使って次の最小 manifest を登録できます。
これはローカル確認用であり、実際の導入では consumer が正本として管理する manifest を登録してください。

```bash
LOCAL_ACCESS_TOKEN=$(curl --fail --silent --show-error \
  --request POST \
  --data-urlencode grant_type=password \
  --data-urlencode client_id=feedback-admin \
  --data-urlencode username=feedback-admin \
  --data-urlencode password=feedback-local-only \
  http://localhost:8180/realms/feedback/protocol/openid-connect/token \
  | jq -er '.access_token')

curl --fail-with-body --silent --show-error \
  --request PUT \
  --header "Authorization: Bearer $LOCAL_ACCESS_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{
    "schemaVersion": "1",
    "applicationKey": "inventory",
    "displayName": "Inventory Approval",
    "manifestVersion": "local-1",
    "routes": [
      {
        "pageKey": "inventory.list",
        "template": "/sites/{siteKey}/inventory",
        "label": "在庫一覧",
        "parameters": { "siteKey": { "persistence": "store" } }
      }
    ]
  }' \
  http://localhost:8090/feedback/v1/applications/inventory/manifest
```

登録後、Admin Console の「レビュー」から「新規作成」を選び、状態を「受付中」、レビュー観点を
1 件以上「今回確認」にしてセッションを作成できます。

conformance consumer は製品デモではなく、HostAdapter、画面遷移、短寿命 token exchange、障害時の縮退を
検証する fixture です。fixture の境界と確認項目は
[`apps/feedback-conformance-consumer/README.md`](apps/feedback-conformance-consumer/README.md) にあります。

### ログ確認と終了

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml logs -f feedback-service
docker compose --env-file deploy/.env -f deploy/compose.yaml down
```

DB、証跡、export も含めてローカルデータを削除する場合だけ `--volumes` を付けます。

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml down --volumes
```

`deploy/.env.example` の credential と secret はローカル専用です。本番環境へ転用しないでください。

### Podman を使う場合

同じ構成を Podman Compose でも起動できます。`depends_on.condition` に対応する
`podman-compose` 1.3.0 以上を使用してください。

```bash
podman compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
```

## 開発と検証

依存 package をインストールします。

```bash
npm ci
```

変更を完了する前の標準品質ゲートは次の 1 コマンドです。

```bash
bash scripts/verify-feedback.sh
```

この品質ゲートは Go の code generation / format / vet / unit / race / build、全 npm workspace の
typecheck / test / build、契約 drift、package consumer 適合性、Compose 設定を fail-closed で検証します。
既定では再現性のため `npm ci` も再実行し、Docker Compose が利用できなければ成功扱いにしません。

作業中に対象を絞る場合は次を利用できます。

| コマンド | 対象 |
| --- | --- |
| `bash scripts/verify-feedback-go.sh` | Go Service の生成物、unit / race、build |
| `npm --workspace @feedback/react test` | 指定した npm workspace の test |
| `npm run build` | 全 package と frontend application の build |
| `bash scripts/check-feedback-contracts.sh` | OpenAPI、JSON Schema、生成型、依存境界 |
| `npm run compose:config` | Compose 設定の展開と構文 |

`npm ci` 済みの作業 tree で標準ゲートの clean install だけを省略したい場合は、明示的に次を使えます。

```bash
FEEDBACK_VERIFY_SKIP_NPM_CI=1 bash scripts/verify-feedback.sh
```

最終確認では省略せず、通常の品質ゲートを実行してください。

## standalone 全経路 smoke

空 DB への migration から、OIDC、API、投稿・返信・編集・resolve、Evidence、Export、retention、通知、
mTLS broker までを自動検証します。`curl`、`jq`、`sha256sum`、`cmp`、Docker Compose が必要です。

```bash
bash scripts/smoke-feedback-standalone.sh
```

この script は専用 Compose project を起動し、成功・失敗にかかわらず終了時に作成した container と volume を
削除します。同名の smoke project が起動中の場合や、使用する localhost port が競合する場合は先に停止してください。
監査用の出力を残す場合は、まだ存在しない directory を指定します。

```bash
bash scripts/smoke-feedback-standalone.sh --evidence-output /tmp/feedback-smoke-evidence
```

## 設計上の境界

- Feedback Service は通常 PostgreSQL と private object storage だけを使用し、ホスト DB を参照しません。
- SDK はホストの router、認証、workspace 解決を所有せず、`FeedbackHostAdapter` から受け取ります。
- 標準認証は Feedback audience を持つ直接 OIDC JWT、または契約済み token exchange JWT だけです。
- 実効権限は token scope と DB membership の積集合です。ブラウザ由来の user / role header は信用しません。
- Evidence と Export bucket は公開せず、download は認可付き API を経由します。
- secret に既定値を持たせません。Compose の例示値はローカル fixture に限って使用します。

API または DTO を変更するときは OpenAPI、生成型、互換性文書を同じ変更で更新してください。
環境変数を追加するときは [`docs/environment-variables.md`](docs/environment-variables.md) も更新します。

## ドキュメント

| 読みたい内容 | ドキュメント |
| --- | --- |
| Compose の起動と migration | [`docs/quickstart.md`](docs/quickstart.md) |
| React SPA への組み込み | [`docs/react-integration.md`](docs/react-integration.md) |
| OIDC と token exchange | [`docs/authentication.md`](docs/authentication.md) |
| 全環境変数 | [`docs/environment-variables.md`](docs/environment-variables.md) |
| health、worker、storage、旧 snapshot 移行 | [`docs/operations.md`](docs/operations.md) |
| 証跡 backup と通知 connector | [`docs/backup-and-connectors.md`](docs/backup-and-connectors.md) |
| API / SDK の互換性方針 | [`docs/api-compatibility.md`](docs/api-compatibility.md) |
| upgrade と DB handoff | [`docs/upgrade.md`](docs/upgrade.md) |
| canary、rollback、性能判定 | [`docs/canary-and-rollback.md`](docs/canary-and-rollback.md) |
| release artifact の作成 | [`docs/release.md`](docs/release.md) |

問題を切り分けるときは、まず `docker compose ... ps`、API の `/health/ready`、
`docker compose ... logs feedback-service feedback-migrate` の順に確認してください。
