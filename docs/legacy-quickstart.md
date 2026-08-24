# Legacy Feedback Service

この文書は`/feedback/v1`、PostgreSQL、private object storage、workerを使う旧構成の保守用です。新しいSPAへ導入する場合は使わず、[`Feedback Redmine導入・利用ガイド`](feedback-redmine-installation.md)へ進んでください。

## ローカルで動かす

Go 1.26.5、Node.js、npm、Docker Compose v2が必要です。

```bash
npm ci
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build
```

起動後に次を開きます。

| 画面 | URL |
| --- | --- |
| 業務アプリfixture | `http://localhost:5175` |
| Admin Console | `http://localhost:5174` |
| Keycloak | `http://localhost:8180` |
| MinIO Console | `http://localhost:9001` |

ローカル利用者は`feedback-admin@example.invalid`、passwordは`feedback-local-only`です。`deploy/.env`とこのcredentialはローカル専用です。

主要機能をまとめて確認します。

```bash
bash scripts/smoke-feedback-standalone.sh
```

終了するときは次を実行します。volumeを削除する場合だけ`--volumes`を追加します。

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml down
```

## resourceと権限を同期する

複数Workspaceは、[`deploy/feedback-installation.example.json`](../deploy/feedback-installation.example.json)をコピーして編集し、one-shot bootstrapへ渡します。secretはJSONへ書きません。

```bash
feedback-bootstrap --input /run/config/feedback-installation.json
```

application manifestはresource同期後に適用します。

```bash
feedback manifest apply \
  --input /run/config/application-manifest.json \
  --api-base-url https://feedback.example.com/feedback/v1
```

認証情報は`FEEDBACK_MANIFEST_ACCESS_TOKEN_FILE`、または`FEEDBACK_MANIFEST_TOKEN_URL`とclient credentialsで渡します。access tokenやclient secretを引数へ書かないでください。

CI/CDは次の順で実行します。

1. `feedback-migrate`
2. `feedback-bootstrap --input ...`
3. APIを配備して`/health/ready`を確認
4. `feedback manifest apply ...`
5. consumerと必要なworkerを配備

manifestにないresourceやmembershipは自動削除されません。削除はAdmin Consoleで明示的に行います。

## 認証を設定する

次のどちらか一方以上を設定します。

| 方式 | 必須設定 |
| --- | --- |
| 直接OIDC | `FEEDBACK_OIDC_ISSUER`、`FEEDBACK_OIDC_AUDIENCE` |
| token exchange | `FEEDBACK_TOKEN_EXCHANGE_ISSUER`、`FEEDBACK_TOKEN_EXCHANGE_AUDIENCE`、`FEEDBACK_TOKEN_EXCHANGE_ACTOR_ISSUERS` |

直接OIDCのaccess tokenには、`feedback_permissions`を文字列配列で発行します。使用できる値は`feedback.read`、`feedback.comment`、`feedback.manage`、`feedback.admin`です。

実効権限は、tokenの`feedback_permissions`とDB membershipの共通部分です。tokenだけでmembershipを越える権限は与えられません。両方式を併用する場合はissuerを分けます。browserから渡されたuser名やrole headerは認証に使いません。

全設定名は[`環境変数`](environment-variables.md#legacy-feedback-service)を参照してください。

## Exportとbackupを使う

Admin Consoleの「保存・エクスポート」で形式を選びます。

- CSVまたはXLSX: 集計・表計算用
- 証跡パッケージ: 正規化CSV、コメント履歴、状態履歴、画像、SHA-256 manifestを含むZIP

生成中は画面を開いたまま待ち、`completed`後にダウンロードします。証跡パッケージは業務上の持出し用で、復旧用backupではありません。

復旧用にはPostgreSQLのPITRを設定し、Evidence／Export bucketも同じ復旧時点で保全します。export workerの自動backupを共有フォルダーへ取得する場合は、専用service principalを使って組織側のschedulerから次を実行します。

```bash
feedback-backup-pull
```

API URL、OAuth client、対象application／Workspace、保存先は`FEEDBACK_PULL_*`で渡します。SMB、NFS、SFTPのcredentialをFeedback Serviceへ渡さないでください。

## 更新する

1. PostgreSQLとEvidence／Export bucketを同じ時点でbackupする。
2. stagingで`feedback-migrate`を実行する。
3. API、Admin、workerを同じreleaseへ更新する。
4. 直接OIDCとtoken exchangeのうち、本番で使う経路から投稿・返信・Exportを確認する。
5. 本番で`feedback-migrate`を実行してからruntimeを更新する。

適用済みmigrationは編集・削除せず、新しいmigrationで修正します。checksum mismatchを`flyway repair`で書き換えないでください。

Azure Container Apps用の旧構成を保守する場合は、実体とコマンドを[`deploy/azure/README.md`](../deploy/azure/README.md)で確認してください。

## 開発時に検証する

全体の検証入口は次だけです。

```bash
bash scripts/verify-feedback.sh
```

24時間のlease、cursor、idempotency fault試験が必要な変更では、出力先を新しいファイルにして実行します。

```bash
scripts/soak-feedback-go.sh \
  --duration 24h \
  --interval-seconds 30 \
  --fault-every 20 \
  --output /secure/change-records/feedback-go-soak-24h.json
```
