# Feedback System

既存のReact SPAにフィードバックUIを追加し、投稿・返信・証跡を既存Redmineへ保存します。
Feedback専用DBやobject storageは不要です。

## まずローカルで確認する

Node.js 22.12以上25未満、npm、Docker Engine、Docker Compose v2が必要です。

```bash
npm ci
npm run feedback:redmine:local
```

- Feedbackデモ: `http://127.0.0.1:4173`
- Redmine: `http://127.0.0.1:3001`

```bash
# Redmineのログイン情報を表示
node packages/feedback-redmine-ops/dist/cli.js local credentials

# 終了
node packages/feedback-redmine-ops/dist/cli.js local down
```

このコマンドは評価専用Redmineを新規作成します。既存Redmineには実行しないでください。

## 既存のReactとRedmineへ導入する

前提はReact 18または19、検証済みRedmine（5.1.12、6.0.10、6.1.3、7.0.0）、
HTTPSで公開できるsame-origin gatewayです。

### 1. Redmineを準備する

Feedback専用project、tracker、integration user、role、status、workflow、11個のcustom fieldを作成します。
Rails runnerを利用できる場合は、CLIが変更内容をplanし、承認したdigestだけをapplyできます。

```bash
npx @geibee/feedback-redmine-ops@next provision extract \
  --output /secure/feedback-redmine/provision.rb
```

manifestの例とplan／applyのコマンドは
[`Feedback Redmine導入・運用手順`](docs/feedback-redmine-installation.md#3-既存redmineの準備)にあります。
managed Redmineでは、同じ手順書のREST inspect経路を使用します。

### 2. gatewayとruntime configを配備する

標準gateway imageをbuildし、8080番portをSPAと同じoriginの
`/internal/feedback-redmine/v1`へproxyします。

```bash
docker build \
  --file apps/feedback-redmine-gateway-reference/Dockerfile \
  --tag feedback-redmine-gateway .
```

gatewayには次の値だけをserver-sideで設定します。

- `FEEDBACK_PUBLIC_ORIGIN`: SPAの公開origin
- `FEEDBACK_REDMINE_GATEWAY_PROFILE_FILE`: 生成済み`server-profile.json`
- `FEEDBACK_REDMINE_GATEWAY_API_KEY`または`_FILE`: integration userのAPI key
- `FEEDBACK_PARTICIPANT_SIGNING_KEY`: 32 bytes以上のランダムな秘密値

AWSではCloudFront → ALB、AzureではFront Door → Application Gatewayの内側へSPAとgatewayを配置し、
browserから見えるscheme・host・portを同一にします。gatewayの8080番portは直接公開しません。

SPAと同じoriginの`/.well-known/feedback-redmine.json`から、次を
`Content-Type: application/json`、`Cache-Control: no-store`で返します。

```json
{
  "schemaVersion": "1",
  "enabled": true,
  "profileId": "inventory-production",
  "gatewayBasePath": "/internal/feedback-redmine/v1"
}
```

### 3. Reactへ組み込む

```bash
npm install @geibee/feedback-redmine-plugin@next
```

[`Host Adapterの最小例`](tests/fixtures/feedback-redmine-plugin-vanilla/src/quickstart-adapter.ts)をアプリ用の値とrouterへ接続し、
次のcomponentをアプリケーションrootで一度renderします。

```tsx
import { useEffect } from "react";
import {
  createRedmineFeedbackPluginControllerFromRuntimeConfig,
  type RedmineFeedbackPluginController
} from "@geibee/feedback-redmine-plugin/loader";
import { createQuickstartAdapter } from "./feedback-adapter.js";

const adapter = createQuickstartAdapter();

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

Redmine URL、API key、custom field ID、署名鍵をSPAやruntime configへ含めないでください。

### 4. 接続を確認する

```bash
npx @geibee/feedback-redmine-ops@next doctor \
  --origin https://app.example.com \
  --profile inventory-production
```

最後にSPAから1件投稿し、Redmineへのissue作成、双方からの返信、添付画像を確認すれば導入完了です。
停止するときはruntime configの`enabled`を`false`にします。

## 詳細資料

- 本番配備、backup、upgrade、障害調査: [`docs/feedback-redmine-installation.md`](docs/feedback-redmine-installation.md)
- 環境変数とsecret: [`docs/environment-variables.md`](docs/environment-variables.md)
- APIとpackageの互換性: [`docs/api-compatibility.md`](docs/api-compatibility.md)
- 開発者向けrelease手順: [`docs/release.md`](docs/release.md)
- 従来Feedback Serviceの保守: [`docs/legacy-quickstart.md`](docs/legacy-quickstart.md)

変更後の検証入口は`bash scripts/verify-feedback.sh`です。

## License

[MIT License](LICENSE)
