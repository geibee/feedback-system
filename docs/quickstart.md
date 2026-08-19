# Redmine正本SPA Quickstart

新規導入の標準構成は、Feedback pluginをSPA bundleへ同梱し、同一originのstateless gatewayからRedmineへ接続する方式である。
Feedback専用PostgreSQL、object storage、OIDC Provider、browser拡張機能は必要ない。返信、編集、担当、優先度、状態変更は
Redmine UIで行い、Feedback UIは初回投稿、証跡添付、スレッド参照を担当する。

## 1. Redmineを準備する

REST APIを有効化し、専用project、tracker、最小権限のintegration userと
[`redmine-integration.md`](redmine-integration.md)記載の11 custom fieldsを作成する。integration userのAPI keyは
secret managerに保存し、SPA、HTML、runtime config、browser storageへ渡さない。

## 2. gatewayを組み込む

`@feedback/redmine-gateway`をホストbackendの既存session middleware後段へmountし、
`/internal/feedback-redmine/v1`をSPAと同じoriginで公開する。`FeedbackRedmineGatewayHost`へ既存の認証、profile認可、
resource認可、保存済みresourceの再認可、CSRF検証を接続する。詳細は[`redmine-gateway.md`](redmine-gateway.md)を参照する。

`apps/feedback-redmine-gateway-reference`はローカル確認用であり、demo session adapterは業務resourceを認可しない。
本番へそのまま配備せず、必ずホスト固有のadapterへ置き換える。

## 3. SPAへ同梱する

React 18または19を使うSPAへ`@feedback/redmine-plugin`を追加し、単一のintegration moduleからloader controllerを作る。
controllerの作成だけではReact UI、DOM、通信、timer、router購読を開始しない。

```ts
import { createRedmineFeedbackPluginController } from "@feedback/redmine-plugin/loader";

export const feedback = createRedmineFeedbackPluginController({
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

export function disposeFeedback(): void {
  unsubscribe();
  feedback.destroy();
}
```

feature flag未指定時は有効を既定とする。`setEnabled(false)`は進行中request、polling、購読、React rootとcontroller所有DOMを
破棄するが、draft、follow、pending intentは保持する。再度`true`にするとdynamic importから再mountする。

## 4. 確認する

```bash
npm ci
npm run build
npm run smoke:redmine
bash scripts/verify-feedback.sh
```

最終品質ゲートはskip変数なしの`bash scripts/verify-feedback.sh`である。Redmine 5.1.12、6.0.10、6.1.3、7.0.0の
digest固定conformanceを含み、未実行を成功として扱わない。

## 無効化と完全撤去

- 一時停止: feature flagをfalseにし、`setEnabled(false)`を呼ぶ。SPAの再buildは不要で、ローカル状態は保持する。
- 完全撤去: 先に`await feedback.purgeLocalState()`で現在origin・profileの端末状態だけを削除し、integration moduleの呼出し、
  `@feedback/redmine-plugin`依存、gateway mountを削除する。
- Redmineのissue、journal、attachment、custom fieldsはpluginの無効化・撤去では削除しない。

本番稼働済みの旧Feedback runtimeは存在しない前提のため、DB migration、dual-write、read-only移行期間、rollback用データ変換は
この導入の対象外である。従来runtimeを評価する場合だけ[`legacy-quickstart.md`](legacy-quickstart.md)を参照する。
