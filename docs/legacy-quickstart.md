# Legacy Feedback Service Quickstart

> **Legacy Feedback Service:** この手順はPostgreSQLとobject storageを使う従来runtime向けです。新規導入の標準は
> [`README.md`](../README.md)のRedmine正本SPA構成です。

`npm ci` 後に `bash scripts/verify-feedback.sh` を実行する。Go 1.26.5だけでbackendを検証し、JDK/Gradleを要求しない。
standalone composeは
PostgreSQL 16、MinIO、local OIDC、API、notification/export/retention worker、Admin Console、reference broker、
consumer fixtureだけを起動する。

`deploy/.env.example` を `deploy/.env` へコピーしてから、DockerまたはPodmanのいずれかで起動する。
例示credentialはローカル専用で、本番へ転用しない。Podman Composeは
`depends_on.condition`へ対応する`podman-compose` 1.3.0以上を使用する。

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build
podman compose --env-file deploy/.env -f deploy/compose.yaml up --build
```

ComposeはAPI/workerより先にone-shot migrationを依存関係として完了する。migrationだけを手動確認する場合は次を使う。
bootstrap後にはone-shotの`feedback manifest apply` jobがapplication manifestを実際に同期し、consumerは登録済みmanifestを読む。
ブラウザ起動時の副作用には依存しない。

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml \
  run --rm --build feedback-migrate
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build
```

全containerを使う投稿・返信・編集・resolve・Evidence・Export・retention・通知・mTLS brokerの確認は
`bash scripts/smoke-feedback-standalone.sh` で実行する。scriptが作ったcontainerとvolumeは終了時に削除する。
稼働済み環境へ移行する前の24時間lease/cursor/idempotency fault検証は、Go-only形状で
`scripts/soak-feedback-go.sh --output <new-summary.json>`を実行する。未投入環境の初回導入では短縮実行を選べる。

本番CI/CDで複数workspaceを同期する方法は[`installation.md`](installation.md)を参照する。
