# Feedback System

React SPAへ画面内フィードバックを追加し、Redmine issue・journal・attachment・custom fieldを唯一の業務データ正本として使う
pluginとsame-origin gatewayです。Feedback専用DBやobject storageを新設せず、ホストアプリの既存sessionとresource認可を利用します。

> 現在のバージョンは`1.0.0-alpha.1`です。npm packageはregistry公開前のため、repository workspaceまたは
> release builderが生成するtarballから利用します。

## 標準構成

```text
React SPA
  └─ @feedback/redmine-plugin/loader
       │  feature flagでdynamic import / unmount
       ▼
same-origin /internal/feedback-redmine/v1
  └─ @feedback/redmine-gateway
       │  session認証・resource認可・CSRF
       │  server-side integration API key
       ▼
Redmine
  ├─ issue + 11 custom fields
  ├─ journal
  └─ context / evidence attachment
```

Feedback UIは初回投稿、任意のスクリーンショット、スレッド参照を提供します。返信、編集、担当、優先度、状態変更は
Redmine UIで行います。gatewayはstatelessで、DB、queue、cache、filesystem upload、object storageを持ちません。

ブラウザ拡張機能は配布しません。pluginをSPA buildへ同梱し、hostのfeature flagからいつでも有効化・無効化できる境界を
標準にします。

## SPAへ組み込む

標準入口は`@feedback/redmine-plugin/loader`です。controllerを作成しただけではDOM、通信、timer、router購読を開始しません。

```ts
import { createRedmineFeedbackPluginController } from "@feedback/redmine-plugin/loader";

const feedback = createRedmineFeedbackPluginController({
  profileId: "inventory-production",
  adapter,
  getCsrfToken: () =>
    document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? "",
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
- 既存session認証とresource認可を提供できるホストbackend

1. Redmineに専用project、tracker、integration user、11 custom fieldsを作る。
2. `@feedback/redmine-gateway`を既存認証middleware後段へsame-originでmountする。
3. integration userのAPI keyをserver-side secretだけから注入する。
4. SPAに`@feedback/redmine-plugin`を同梱し、loader controllerをfeature flagへ接続する。
5. 初回投稿、参照、無効化、再有効化をstagingで確認する。

詳しい手順は[`docs/quickstart.md`](docs/quickstart.md)、Redmine準備は
[`docs/redmine-integration.md`](docs/redmine-integration.md)、gateway SPIは
[`docs/redmine-gateway.md`](docs/redmine-gateway.md)を参照してください。

`apps/feedback-redmine-gateway-reference`はローカル確認用です。demo session adapterは業務resourceを認可しないため、
本番では必ずホスト固有の認証・認可・CSRF adapterへ置き換えます。

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

Redmine releaseには`@feedback/contracts`、共有core/DOM capture、Redmine core/UI/plugin/gatewayのtarball、manifest、SHA-256を含みます。
ブラウザ拡張ZIP、React runtime入りbundle、reference gateway imageは含みません。詳細は[`docs/release.md`](docs/release.md)を
参照してください。

## 公開契約

- Gateway OpenAPI: [`contracts/feedback/redmine-gateway.openapi.yaml`](contracts/feedback/redmine-gateway.openapi.yaml)
- JSON Schema: [`contracts/feedback/schemas`](contracts/feedback/schemas)
- npm packages: `@feedback/contracts`、`@feedback/core`、`@feedback/dom-capture`、`@feedback/redmine-core`、
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
