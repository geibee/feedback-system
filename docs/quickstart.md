# Redmine正本SPA Quickstart

ローカル評価、既存Redmine、本番、backup、upgradeを含む完全な手順は
[`feedback-redmine-installation.md`](feedback-redmine-installation.md)を参照する。

ローカル評価だけなら次で起動できる。

```bash
npm ci
npm run feedback:redmine:local
```

新規導入の標準構成は、Feedback pluginをSPA bundleへ同梱し、同一originのstateless gatewayからRedmineへ接続する方式である。
Feedback専用PostgreSQL、object storage、OIDC Provider、browser拡張機能は必要ない。利用者はFeedback UIから位置指定投稿、
返信、自己編集を行い、開発者はRedmineから返信、担当、優先度、状態を更新する。双方の更新は同じRedmine issue/journalから表示される。

## 1. Redmineを準備する

REST APIを有効化し、専用project、tracker、最小権限のintegration userと
[`redmine-integration.md`](redmine-integration.md)記載の11 custom fieldsを作成する。integration userのAPI keyは
secret managerに保存し、SPA、HTML、runtime config、browser storageへ渡さない。

## 2. gatewayを組み込む

`@geibee/redmine-gateway`を`/internal/feedback-redmine/v1`としてSPAと同じoriginで公開する。Redmine API keyに加え、
32 bytes以上のparticipant署名鍵をsecret managerから`participantSigningKey`へ注入する。SDKはOIDC JWTやhost sessionをgatewayへ
送らない。初回にgatewayが署名したparticipant credentialを取得し、同じorigin・browser profileのlocalStorageへ保存する。

公開participant modeでは読み取り、新規投稿、返信を同一origin利用者へ公開する。Origin/Fetch Metadata検査は認証ではなく、
participant credentialも自己編集の所有確認だけを目的とする。gateway自体の公開範囲を狭める場合は外側へアクセス制御を追加する。

## 3. SPAへ同梱する

React 18または19を使うSPAへ`@geibee/redmine-plugin`を追加し、単一のintegration moduleからloader controllerを作る。
runtime loaderは最初に公開設定だけを取得し、`enabled:false`ではReact UI、DOM、gateway通信、timer、router購読を開始しない。

```ts
import { useEffect } from "react";
import { createRedmineFeedbackPluginControllerFromRuntimeConfig } from "@geibee/redmine-plugin/loader";
import type { RedmineFeedbackPluginController } from "@geibee/redmine-plugin/loader";

export function FeedbackIntegration(): null {
  useEffect(() => {
    const abort = new AbortController();
    let feedback: RedmineFeedbackPluginController | null = null;
    void createRedmineFeedbackPluginControllerFromRuntimeConfig({
      adapter,
      contextMenu: true,
      targetResolver: mapTargetResolver,
      pinPositionProvider: mapPinPositionProvider,
      signal: abort.signal,
      onUnavailable: (error) => console.error("Feedbackを利用できません", error)
    }).then((created) => {
      if (abort.signal.aborted) created?.destroy();
      else feedback = created;
    });
    return () => {
      abort.abort();
      feedback?.destroy();
    };
  }, []);
  return null;
}
```

`/.well-known/feedback-redmine.json`の`enabled`を配備時feature flagとして使い、次回ページロードから反映する。
取得は既定5秒でtimeoutする。React cleanupの`AbortSignal`により、StrictMode、route遷移、microfrontend破棄後の遅延mountを防ぐ。
origin rootを変更できないsubpath配備では`configPath: "/inventory/.well-known/feedback-redmine.json"`のように明示する。
`setEnabled(false)`は進行中request、polling、購読、React rootとcontroller所有DOMを
破棄するが、draft、follow、pending intentは保持する。再度`true`にするとdynamic importから再mountする。

`＋ フィードバック`は対象選択modeへ入り、`data-feedback-key`を持つDOM要素を優先し、なければ画面相対座標へfallbackする。
`contextMenu: true`の場合だけ右クリック投稿を有効化する。MapLibreでは`@geibee/maplibre`のtarget resolverとpin providerを渡す。
スクリーンショットはProfileで明示的に無効化しない限り、pluginが既定DOM providerで取得する。Host Adapterへの
`captureEvidence`実装は不要で、MapLibre canvasなどhost固有処理が必要な場合だけ差し替える。位置選択後にFeedbackピンを
画像へ焼き込んでpreviewし、取得成功時は投稿へ自動添付する。取得失敗時は理由を表示し、画像なしでも送信できる。
DOM providerを使うHostのCSPでは`img-src`に`data:`と`blob:`を許可する。
`他の人の投稿を見る`は同じProfileのWorkspace全体を画面単位で表示し、別画面の項目はadapterの`navigate`完了後に開く。
新規issueの説明欄には初回コメントと、同じSPA画面でthreadを開くsame-origin URLだけを保存する。

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

- 一時停止: runtime configをfalseへ配備してページをreloadするか、`setEnabled(false)`を呼ぶ。SPAの再buildは不要で、ローカル状態は保持する。
- 完全撤去: 先に`await feedback?.purgeLocalState()`で現在origin・profileの端末状態だけを削除し、integration moduleの呼出し、
  `@geibee/redmine-plugin`依存、gateway mountを削除する。
- `purgeLocalState()`はparticipant credentialも削除する。再有効化後は新しいUUIDとなり、以前の投稿を自己編集できない。
- Redmineのissue、journal、attachment、custom fieldsはpluginの無効化・撤去では削除しない。

本番稼働済みの旧Feedback runtimeは存在しない前提のため、DB migration、dual-write、read-only移行期間、rollback用データ変換は
この導入の対象外である。従来runtimeを評価する場合だけ[`legacy-quickstart.md`](legacy-quickstart.md)を参照する。
