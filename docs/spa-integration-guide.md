# SPA導入ガイド

この文書は、Redmineを正本とする`@geibee/feedback-redmine-plugin`を既存SPAへ追加する標準手順です。
通常のDOM画面への組み込み、gateway配備、設定と動作確認を扱います。Legacy Feedback Serviceの
`@geibee/react`と`/feedback/v1`は対象外です。

WebGL地図を使用する画面だけ、基本導入の完了後に任意の
[`MapLibre・地物連携ガイド`](maplibre-integration.md)を参照してください。

## 2つのenabledを区別する

| 設定 | 所有者 | `false`の動作 |
| --- | --- | --- |
| runtime configの`enabled` | SPA配備 | plugin chunk、UI DOM、gateway通信、購読、timerを開始しない |
| client profileの`capture.enabled` | gateway profile | pluginは動作するが、スクリーンショットを作成・添付しない |

`runtime config.enabled=true`かつ`profile.capture.enabled=false`では、コメントの投稿、一覧、返信は利用できます。
スクリーンショットだけを止めたい場合にruntime configを無効化しないでください。逆に緊急停止ではruntime configを
`false`にし、plugin全体をfail-closedにします。

## SPAへ導入する

SPAと同じoriginから次のruntime configを`Content-Type: application/json`、`Cache-Control: no-store`で返します。

```json
{
  "schemaVersion": "1",
  "enabled": true,
  "profileId": "inventory-production",
  "gatewayBasePath": "/internal/feedback-redmine/v1"
}
```

Host Adapterを用意し、アプリケーションrootでcontrollerを1つ作成します。

```tsx
import { useEffect } from "react";
import {
  createRedmineFeedbackPluginControllerFromRuntimeConfig,
  type RedmineFeedbackPluginController
} from "@geibee/feedback-redmine-plugin/loader";
import { adapter } from "./feedback-adapter.js";

export function FeedbackIntegration(): null {
  useEffect(() => {
    const abort = new AbortController();
    let controller: RedmineFeedbackPluginController | null = null;

    void createRedmineFeedbackPluginControllerFromRuntimeConfig({
      adapter,
      contextMenu: true,
      signal: abort.signal,
      onUnavailable: (error) => console.error("Feedbackを利用できません", error)
    }).then((created) => {
      if (abort.signal.aborted) created?.destroy();
      else controller = created;
    });

    return () => {
      abort.abort();
      controller?.destroy();
    };
  }, []);
  return null;
}
```

client profileの`capture.enabled`が`true`なら、`adapter.captureEvidence`を指定しなくても通常DOMを撮影します。
`data-feedback-mask`は黒塗りし、plugin自身は画像から除外します。Redmine URL、API key、custom field ID、
participant署名鍵をSPAやruntime configへ含めないでください。

## gatewayを既存Docker Composeへ追加する

標準gatewayはFeedback専用DBやobject storageを使いません。既存SPAのreverse proxyからgatewayを同一originの
`/internal/feedback-redmine/v1`へ公開し、gateway containerの8080番portは外部公開しません。

profile fileを使う場合の追加例です。`server-profile.json`から参照する`client-profile.json`も同じread-only volumeへ置きます。

```yaml
services:
  redmine-db:
    image: postgres:17-bookworm
    environment:
      POSTGRES_DB: redmine
      POSTGRES_USER: redmine
      POSTGRES_PASSWORD: ${REDMINE_DB_PASSWORD}
    volumes:
      - redmine-db:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U redmine -d redmine"]
      interval: 5s
      timeout: 5s
      retries: 30

  redmine:
    image: redmine:7.0.0-bookworm
    environment:
      REDMINE_DB_POSTGRES: redmine-db
      REDMINE_DB_DATABASE: redmine
      REDMINE_DB_USERNAME: redmine
      REDMINE_DB_PASSWORD: ${REDMINE_DB_PASSWORD}
      REDMINE_SECRET_KEY_BASE: ${REDMINE_SECRET_KEY_BASE}
    depends_on:
      redmine-db:
        condition: service_healthy
    volumes:
      - redmine-files:/usr/src/redmine/files
    healthcheck:
      test: ["CMD", "ruby", "-rnet/http", "-e", "exit(Net::HTTP.get_response(URI('http://127.0.0.1:3000/')).is_a?(Net::HTTPSuccess) ? 0 : 1)"]
      interval: 5s
      timeout: 5s
      retries: 60

  feedback-redmine-gateway:
    image: feedback-redmine-gateway:${FEEDBACK_REDMINE_GATEWAY_VERSION}
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,nodev,size=16m
    cap_drop: ["ALL"]
    security_opt: ["no-new-privileges:true"]
    environment:
      FEEDBACK_PUBLIC_ORIGIN: https://app.example.com
      FEEDBACK_REDMINE_GATEWAY_PROFILE_FILE: /config/server-profile.json
      FEEDBACK_REDMINE_GATEWAY_API_KEY_FILE: /run/secrets/redmine-api-key
      FEEDBACK_PARTICIPANT_SIGNING_KEY: ${FEEDBACK_PARTICIPANT_SIGNING_KEY}
    volumes:
      - ./feedback-redmine:/config:ro
    secrets:
      - redmine-api-key
    depends_on:
      redmine:
        condition: service_healthy

secrets:
  redmine-api-key:
    file: ./secrets/redmine-api-key

volumes:
  redmine-db:
  redmine-files:
```

実際のPostgreSQL/Redmine imageは検証済みversionとdigestへ固定してください。本番profileの`redmineBaseUrl`には
gatewayから到達できるHTTPS endpointを指定します。同じDocker networkの平文`http://redmine:3000`は
`NODE_ENV=development`のローカル評価だけで利用できます。Redmine project、tracker、integration user、workflow、
custom fieldはgateway起動前に[`Feedback Redmine導入・運用手順`](feedback-redmine-installation.md)でprovisionします。

SPA側Nginxへ次を追加します。

```nginx
location = /.well-known/feedback-redmine.json {
  add_header Cache-Control "no-store" always;
  try_files $uri =404;
}

location /internal/feedback-redmine/v1/ {
  proxy_pass http://feedback-redmine-gateway:8080;
  proxy_http_version 1.1;
  proxy_set_header Host $http_host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_request_buffering off;
  proxy_read_timeout 65s;
}
```

## 環境変数だけでgatewayを構成する

標準gatewayはprofile fileの代わりに`FEEDBACK_REDMINE_GATEWAY_PROFILE_JSON`を受け付けます。最大64 KiBで、
fileとの同時指定は拒否します。file版の`clientProfileRef`を、同じ内容の`clientProfile` objectへ置き換えたJSONです。
Redmine API keyとparticipant署名鍵はprofile JSONへ入れず、別のsecret環境変数またはsecret fileから注入します。

```yaml
services:
  feedback-redmine-gateway:
    image: feedback-redmine-gateway:${FEEDBACK_REDMINE_GATEWAY_VERSION}
    environment:
      FEEDBACK_PUBLIC_ORIGIN: https://app.example.com
      FEEDBACK_REDMINE_GATEWAY_PROFILE_JSON: ${FEEDBACK_REDMINE_GATEWAY_PROFILE_JSON}
      FEEDBACK_REDMINE_GATEWAY_API_KEY: ${FEEDBACK_REDMINE_GATEWAY_API_KEY}
      FEEDBACK_PARTICIPANT_SIGNING_KEY: ${FEEDBACK_PARTICIPANT_SIGNING_KEY}
```

`FEEDBACK_REDMINE_GATEWAY_PROFILE_JSON`はComposeへ渡す前に1行JSONへ変換します。環境変数管理基盤が大きなJSONを
扱いにくい場合はprofile file方式を使用してください。

provision済みのfile版profileからは、次のようにsecretを含まないenv-only JSONを生成できます。

```bash
jq -c --slurpfile client ./client-profile.json \
  'del(.clientProfileRef) + {clientProfile: $client[0]}' \
  ./server-profile.json
```

## 確認項目

1. runtime configを`enabled=false`にするとplugin DOMとgateway通信が発生しない。
2. `enabled=true`で通常DOMの投稿、一覧、返信が動く。
3. profileの`capture.enabled=true`で画像が添付され、`false`でコメントだけが投稿される。
4. 新規Redmine issueの説明にクリック可能なSPA URLが表示され、該当画面を開く。
5. `doctor`が同一origin gatewayとprofileを正常と判定する。

```bash
npx @geibee/feedback-redmine-ops@next doctor \
  --origin https://app.example.com \
  --profile inventory-production
```
