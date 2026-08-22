# @geibee/feedback-redmine-plugin

業務アプリケーションのSPA bundleへ組み込むFeedback pluginです。標準入口は
`@geibee/feedback-redmine-plugin/loader`の`createRedmineFeedbackPluginControllerFromRuntimeConfig()`です。最初に公開runtime configだけを取得し、
`enabled:false`ではReact UI、DOM、gateway通信、購読、timerを作成しません。有効時だけUIをdynamic importして
Shadow DOMへmountします。

```ts
import { useEffect } from "react";
import { createRedmineFeedbackPluginControllerFromRuntimeConfig } from "@geibee/feedback-redmine-plugin/loader";
import type { RedmineFeedbackPluginController } from "@geibee/feedback-redmine-plugin/loader";
import { createQuickstartAdapter } from "./quickstart-adapter.js";

const adapter = createQuickstartAdapter();

export function FeedbackIntegration(): null {
  useEffect(() => {
    const abort = new AbortController();
    let feedback: RedmineFeedbackPluginController | null = null;
    void createRedmineFeedbackPluginControllerFromRuntimeConfig({
      adapter,
      contextMenu: true,
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

既定では`/.well-known/feedback-redmine.json`から`enabled`、`profileId`、same-originの`gatewayBasePath`、任意の`submissionNotice`を`no-store`で読みます。
取得または厳密なschema検証に失敗した場合はfail-closedでnullを返し、UIや通信を開始しません。配備時に有効・無効を変更でき、
SPAの再buildは不要です。従来の`createRedmineFeedbackPluginController()`も、host feature flagへ直接接続する用途で利用できます。
取得timeoutは既定5秒で、`timeoutMs`により1〜60000msの範囲で変更できます。React cleanupから`signal`を中止すると
`onUnavailable`へ通知せず終了し、初期化途中のcontrollerも破棄します。subpath配備では同一originのroot-relativeな`configPath`を指定できます。
任意機能の設定取得でhost SPAの起動を止めないため、factoryをtop-level `await`せず、上記のようにReact effect内で開始します。
runtime loaderでは案内を呼出しoptionから上書きできず、runtime JSONを唯一の設定源にします。直接
`createRedmineFeedbackPlugin()`または`createRedmineFeedbackPluginController()`を使うintegrationだけは、同じshapeの`submissionNotice` optionを指定できます。

`mount`を省略すると、controllerは`document.body`配下に専用要素を作成し、無効化時に要素ごと削除します。
host所有要素を`mount`へ指定した場合は、plugin内容だけを破棄してhost要素を残します。`purgeLocalState()`は
完全撤去時などに現在origin・profileのdraft、follow、pending intentを明示削除する操作で、通常の
`setEnabled(false)`や`destroy()`は保存内容を削除しません。
participant credentialも完全撤去時だけ削除され、再発行後は以前の自己編集権を復元できません。

手動でライフサイクルを管理する場合は、従来どおりpackage rootの`createRedmineFeedbackPlugin()`へmount先、
profile ID、host adapterを渡せます。`contextMenu: true`を明示した場合だけ右クリック投稿を有効化します。

Redmine API key、Redmine URL、project/tracker/custom field IDは公開optionに存在しません。通信先は同一originの
relative gateway pathだけで、`credentials`と`mode`を`same-origin`へ固定します。
初回に非公開browser profile UUIDを採番し、gatewayが別に導出した公開participant UUIDと署名済みcredentialをorigin/profile別の
localStorageへ保存します。OIDC JWTやhost session tokenをrequest bodyへ渡しません。非公開UUIDはRedmineや会話応答へ出しません。
localStorage削除後は新しいparticipant UUIDを採番し、以前の自己編集権は復元しません。

React 18または19とReact DOMはpeer dependencyです。SPAが使用するReact runtimeを共有し、plugin専用のReact runtimeや
self-hosted bundleは配布しません。配布buildはJavaScript source mapを含めず、Shadow DOM内へ共通styleを閉じ込めます。
Profileでcaptureを有効にすると、Host Adapterに`captureEvidence`がなくても既定DOM providerを自動利用します。独自providerは
MapLibre canvasなどhost固有の前処理が必要な場合だけ指定します。保存画像には選択位置のFeedbackピンを焼き込みます。
遅延生成されたMapLibre mapは`controller.registerMapLibreMap(map)`またはhandleの同名methodへ登録し、map破棄前に戻り値を
呼び出します。controllerは無効化中の登録を保持し、再有効化後のmountへ引き継ぎます。capture有効時に未登録の
MapLibre WebGL canvasを検出すると、地図が白紙になる可能性をUIで通知します。
handleの`downloadDiagnostics()`は、直近100 operationのrequest ID、operation、profile ID、HTTP status、duration、error codeだけを
JSONとして明示downloadします。本文、thread ID、host principal、filename、API keyは収集しません。
DOM画面だけで動作する完全なHost Adapter、runtime config、gateway配備を含む最短手順は
[`README.md`](https://github.com/geibee/feedback-system/blob/main/README.md)を参照してください。
基本導入とCompose例は
[`SPA導入ガイド`](https://github.com/geibee/feedback-system/blob/main/docs/spa-integration-guide.md)を参照してください。
MapLibreやcustom targetは基本導入に含めず、必要なHostだけが
[`MapLibre・地物連携ガイド`](https://github.com/geibee/feedback-system/blob/main/docs/maplibre-integration.md)に沿って追加します。
