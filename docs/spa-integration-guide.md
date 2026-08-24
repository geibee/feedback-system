# SPA導入ガイド

この手順を終えると、既存React SPAにFeedbackボタンが表示され、投稿・返信・スクリーンショットがRedmineへ保存されます。先に[`Feedback Redmine導入・利用ガイド`](feedback-redmine-installation.md#3-既存redmineの準備)を完了し、次の3ファイルとRedmine API keyを用意してください。

- `client-profile.json`
- `server-profile.json`
- `runtime-config.json`
- Feedback専用integration userのRedmine API key

MapLibreを使わないSPAは、この文書だけで導入できます。

## 1. packageを追加する

gatewayと同じversionを指定します。

```bash
export FEEDBACK_REDMINE_VERSION='1.0.0-alpha.6'
npm install "@geibee/feedback-redmine-plugin@${FEEDBACK_REDMINE_VERSION}"
```

## 2. Host Adapterを実装する

[`quickstart-adapter.ts`](../tests/fixtures/feedback-redmine-plugin-vanilla/src/quickstart-adapter.ts)をSPAへコピーし、次を実際のrouterと画面データへ置き換えます。

| method | 返すもの |
| --- | --- |
| `getContext` | application、environment、Workspace、release |
| `getLocation` | 現在の画面を表す安定したpage keyとroute情報 |
| `getResourceRef` | 注文番号など、Feedbackを関連付ける業務データの安定ID |
| `subscribe` | routeや対象データが変わったときにlistenerを呼ぶ購読 |
| `navigate` | 一覧から別画面のFeedbackを開くための画面遷移 |

個人情報や業務本文をkeyへ入れないでください。必要ならhash化した値を使います。

次のcomponentをアプリケーションrootで1回だけmountします。

```tsx
import { useEffect } from "react";
import {
  createRedmineFeedbackPluginControllerFromRuntimeConfig,
  type RedmineFeedbackPluginController
} from "@geibee/feedback-redmine-plugin/loader";
import { createFeedbackAdapter } from "./feedback-adapter.js";

const adapter = createFeedbackAdapter();

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

`contextMenu: true`は右クリックからの投稿を有効にします。不要なら`false`にします。

## 3. runtime configを公開する

生成済み`runtime-config.json`をSPAの次のURLへ配置します。

```text
https://app.example.com/.well-known/feedback-redmine.json
```

応答には次のheaderを付けます。

```text
Content-Type: application/json
Cache-Control: no-store
X-Content-Type-Options: nosniff
```

runtime configへsecret、Redmine URL、数値IDを追加しないでください。Feedbackを緊急停止するときは`enabled`を`false`へ変えて配備し、利用者にページを再読み込みしてもらいます。SPAの再buildは不要です。

## 4. gatewayを配備する

`server-profile.json`と`client-profile.json`を同じread-only directoryへ置きます。Redmine API keyとparticipant署名鍵はsecretとして渡します。

既存Composeへ追加する最小例です。

```yaml
services:
  feedback-redmine-gateway:
    image: ${FEEDBACK_REDMINE_GATEWAY_IMAGE:?digest固定のimageを指定してください}
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,nodev,size=16m
    cap_drop: ["ALL"]
    security_opt: ["no-new-privileges:true"]
    environment:
      FEEDBACK_PUBLIC_ORIGIN: https://app.example.com
      FEEDBACK_REDMINE_GATEWAY_PROFILE_FILE: /config/server-profile.json
      FEEDBACK_REDMINE_GATEWAY_API_KEY_FILE: /run/secrets/redmine-api-key
      FEEDBACK_PARTICIPANT_SIGNING_KEY: ${FEEDBACK_PARTICIPANT_SIGNING_KEY:?設定してください}
      FEEDBACK_REDMINE_OPTIONAL_ISSUE_FIELDS: ${FEEDBACK_REDMINE_OPTIONAL_ISSUE_FIELDS:-}
    volumes:
      - ./feedback-redmine:/config:ro
    secrets:
      - redmine-api-key

secrets:
  redmine-api-key:
    file: ./secrets/redmine-api-key
```

imageはrelease manifestのdigestで固定します。取得コマンドは[`Feedback Redmine導入・利用ガイド`](feedback-redmine-installation.md#41-gatewayを配備する)にあります。

gatewayの8080番portは外部公開しません。[`nginx-location.conf.example`](../deploy/feedback-redmine/nginx-location.conf.example)の2つの`location`を、TLSを終端するSPAのserver blockへ追加してください。別のreverse proxyを使う場合も、同じoriginの次のpathへ転送します。

```text
/internal/feedback-redmine/v1/ -> feedback-redmine-gateway:8080
```

## 5. 確認する

まず公開ファイルとgatewayを確認します。

```bash
curl --fail --silent --show-error \
  https://app.example.com/.well-known/feedback-redmine.json

curl --fail --silent --show-error \
  https://app.example.com/internal/feedback-redmine/v1/health/ready

npx "@geibee/feedback-redmine-ops@${FEEDBACK_REDMINE_VERSION}" doctor \
  --origin https://app.example.com \
  --profile inventory-production
```

次にstagingのブラウザで確認します。

1. Feedbackボタンが表示される。
2. 画面上の対象を選び、1件投稿できる。
3. Redmineにチケットとスクリーンショットが作成される。
4. SPAから返信し、Redmineの注記へ反映される。
5. Redmineで状態を変更し、SPAを再表示すると反映される。

MapLibreの地図がある画面だけ、続けて[`MapLibre連携`](maplibre-integration.md)を行います。

## 困ったとき

| 症状 | 確認するもの |
| --- | --- |
| Feedbackボタンが出ない | runtime configが200、JSON、`enabled:true`か |
| gatewayがreadyにならない | profileのmount先、API key file、署名鍵、`FEEDBACK_PUBLIC_ORIGIN` |
| 投稿が401になる | integration userのRedmine API key |
| 投稿が403になる | integration userのproject membershipとFeedback role |
| 画像だけ添付されない | `client-profile.json`の`capture.enabled`、CSP、画像／tileのCORS |
| 親チケット欄が出ない | gatewayの`FEEDBACK_REDMINE_OPTIONAL_ISSUE_FIELDS` |
