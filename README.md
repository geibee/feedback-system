# Feedback System

React SPAへ画面内フィードバックを追加し、Redmine issue・journal・attachment・custom fieldを唯一の業務データ正本として使う
pluginとsame-origin gatewayです。Feedback専用DBやobject storageを新設せず、利用者をRedmineへログインさせずにUI内で会話を完結させます。

> 現在のバージョンは`1.0.0-alpha.2`です。npm packageはregistry公開前のため、repository workspaceまたは
> release builderが生成するtarballから利用します。

## 標準構成

```text
React SPA
  └─ @feedback/redmine-plugin/loader
       │  feature flagでdynamic import / unmount
       ▼
same-origin /internal/feedback-redmine/v1
  └─ @feedback/redmine-gateway
       │  Origin/Fetch Metadata・participant credential
       │  server-side integration API key
       ▼
Redmine
  ├─ issue + 11 custom fields
  ├─ journal
  └─ context / evidence attachment
```

Feedback UIは任意位置の投稿、任意のスクリーンショット、返信、自己編集、編集履歴、未読、Redmine更新の自動反映を提供します。
担当、優先度、状態変更は開発者がRedmineで行います。gatewayはstatelessで、DB、queue、cache、filesystem upload、object storageを持ちません。

ブラウザ拡張機能は配布しません。pluginをSPA buildへ同梱し、hostのfeature flagからいつでも有効化・無効化できる境界を
標準にします。

## SPAへ組み込む

標準入口は`@feedback/redmine-plugin/loader`です。controllerを作成しただけではDOM、通信、timer、router購読を開始しません。

```ts
import { createRedmineFeedbackPluginController } from "@feedback/redmine-plugin/loader";

const feedback = createRedmineFeedbackPluginController({
  profileId: "inventory-production",
  adapter,
  contextMenu: true,
  targetResolver: mapTargetResolver,
  pinPositionProvider: mapPinPositionProvider,
  onUnavailable: (error) => console.error("Feedbackを利用できません", error)
});

await feedback.setEnabled(featureFlags.feedback ?? true);
const unsubscribe = featureFlags.subscribe("feedback", (enabled) => {
  void feedback.setEnabled(enabled);
});

// SPA自体を破棄するとき
unsubscribe();
feedback.destroy();
```

`setEnabled(false)`は通信、polling、購読、React root、controller所有DOMを破棄します。draft、follow、pending intentは保持し、
再有効化できます。完全撤去時だけ`await feedback.purgeLocalState()`を明示実行し、integration module、npm依存、gateway mountを
削除します。Redmine上のデータは削除しません。

React 18または19はSPAとpeer dependencyとして共有します。Redmine API key、Redmine URL、project/tracker/custom field IDを
browserへ渡す公開optionはありません。

## 導入

必要なもの:

- Node.js 22以上25未満とnpm
- REST APIを有効化したRedmine 5.1.12以上
- React 18または19のSPA
- 32 bytes以上のparticipant署名鍵をsecretとして注入できるsame-origin backend

1. Redmineに専用project、tracker、integration user、11 custom fieldsを作る。
2. `@feedback/redmine-gateway`をsame-originでmountし、participant署名鍵を注入する。
3. integration userのAPI keyをserver-side secretだけから注入する。
4. SPAに`@feedback/redmine-plugin`を同梱し、loader controllerをfeature flagへ接続する。
5. 位置指定投稿、返信、自己編集、Redmine側返信の反映、無効化、再有効化をstagingで確認する。

詳しい手順は[`docs/quickstart.md`](docs/quickstart.md)、Redmine準備は
[`docs/redmine-integration.md`](docs/redmine-integration.md)、gateway SPIは
[`docs/redmine-gateway.md`](docs/redmine-gateway.md)を参照してください。

`apps/feedback-redmine-gateway-reference`は公開participant modeの最小構成です。同一origin検査はCSRF緩和であり、実在人物の
認証ではありません。公開範囲を限定する必要がある環境ではgatewayの外側に別のアクセス制御を置きます。

## 開発と検証

```bash
npm ci
npm run build
npm run smoke:redmine
bash scripts/verify-feedback.sh
```

`npm run build`は共有契約とRedmine SPA/gateway packageをbuildします。従来runtimeだけは`npm run build:legacy`、
repository全体は`npm run build:all`です。標準品質ゲートはskip変数なしの`bash scripts/verify-feedback.sh`で、
package、browser lifecycle/security、gateway container、digest固定Redmine 4-version matrix、legacy互換経路を検証します。

## Release

```bash
bash scripts/build-feedback-redmine-release.sh \
  --output /tmp/feedback-redmine-release \
  --version 1.0.0-rc.1
```

Redmine releaseには`@feedback/contracts`、共有core/DOM capture/React UI、MapLibre、Redmine core/UI/plugin/gatewayのtarball、manifest、SHA-256を含みます。
ブラウザ拡張ZIP、React runtime入りbundle、reference gateway imageは含みません。詳細は[`docs/release.md`](docs/release.md)を
参照してください。

## 公開契約

- Gateway OpenAPI: [`contracts/feedback/redmine-gateway.openapi.yaml`](contracts/feedback/redmine-gateway.openapi.yaml)
- JSON Schema: [`contracts/feedback/schemas`](contracts/feedback/schemas)
- npm packages: `@feedback/contracts`、`@feedback/core`、`@feedback/dom-capture`、`@feedback/react-ui`、`@feedback/maplibre`、`@feedback/redmine-core`、
  `@feedback/redmine-react`、`@feedback/redmine-plugin`、`@feedback/redmine-gateway`
- Redmine保存契約: issue custom fields、description metadata、`feedback-context-v1.json`

APIまたはDTOを変更するときはOpenAPI、生成型、[`docs/api-compatibility.md`](docs/api-compatibility.md)を同じ変更で更新します。

## Legacy Feedback Service

PostgreSQL、private object storage、OIDC、Admin Consoleを使う従来Feedback Serviceは互換経路として維持しますが、
新規導入の既定ではありません。評価・保守時は[`docs/legacy-quickstart.md`](docs/legacy-quickstart.md)を参照してください。

本番投入済み環境は存在しない前提のため、Redmineへのデータ移行、dual-write、read-only切替期間、rollback変換は提供しません。

## ドキュメント

| 内容 | ドキュメント |
| --- | --- |
| Redmine SPA Quickstart | [`docs/quickstart.md`](docs/quickstart.md) |
| Redmine projectと11 custom fields | [`docs/redmine-integration.md`](docs/redmine-integration.md) |
| same-origin gateway | [`docs/redmine-gateway.md`](docs/redmine-gateway.md) |
| 環境変数とsecret境界 | [`docs/environment-variables.md`](docs/environment-variables.md) |
| API／package互換性 | [`docs/api-compatibility.md`](docs/api-compatibility.md) |
| release artifact | [`docs/release.md`](docs/release.md) |
| Legacy runtime Quickstart | [`docs/legacy-quickstart.md`](docs/legacy-quickstart.md) |

## License

[MIT License](LICENSE)
