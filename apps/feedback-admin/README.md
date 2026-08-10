# Feedback Admin Console

Feedback Service v1 のみを利用する独立管理 SPA。導入先の業務API、DB、router、権限体系には依存しない。

ローカルではリポジトリルートで `npm ci` を実行し、必要な公開設定を指定して起動する。

```bash
VITE_FEEDBACK_API_BASE=http://localhost:8090/feedback/v1 \
VITE_FEEDBACK_ADMIN_OIDC_AUTHORITY=http://localhost:8180/realms/feedback \
VITE_FEEDBACK_ADMIN_OIDC_CLIENT_ID=feedback-admin \
VITE_FEEDBACK_ADMIN_APPLICATION_KEY=inventory \
VITE_FEEDBACK_ADMIN_ENVIRONMENT_KEY=local \
VITE_FEEDBACK_ADMIN_WORKSPACE_KEY=east \
npm --workspace @feedback/admin-console run dev
```

または次のローカルfixture一式を起動する。

```bash
docker compose --env-file deploy/.env.example -f deploy/compose.yaml up --build
podman compose --env-file deploy/.env.example -f deploy/compose.yaml up --build
```

管理画面は `http://localhost:5174` に起動する。`VITE_*` はブラウザへ配布されるため、secret を設定しない。
導入先のconsumerは `applicationKey`、`environmentKey`、`workspaceKey` query parameter を付けて
対象 workspace を開ける。OIDC redirect 中はこの3値だけを sessionStorage に一時保存し、tokenやconsumerの
任意 query は Admin Console へ転送しない。
