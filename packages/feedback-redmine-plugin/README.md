# @feedback/redmine-plugin

業務アプリケーションのSPA bundleへ組み込むFeedback pluginです。標準入口は
`@feedback/redmine-plugin/loader`の`createRedmineFeedbackPluginController()`です。controllerを作成しただけでは
React UIを読み込まず、DOM、通信、購読、timerも作成しません。業務アプリケーションのfeature flagを
`setEnabled()`へ接続すると、有効時だけUIをdynamic importしてShadow DOMへmountします。

```ts
import { createRedmineFeedbackPluginController } from "@feedback/redmine-plugin/loader";

const feedback = createRedmineFeedbackPluginController({
  profileId: "inventory-production",
  adapter,
  contextMenu: true,
  targetResolver,
  pinPositionProvider,
  onUnavailable: (error) => console.error("Feedbackを利用できません", error)
});

await feedback.setEnabled(featureFlags.feedback ?? true);
const unsubscribe = featureFlags.subscribe("feedback", (enabled) => {
  void feedback.setEnabled(enabled);
});

// SPAを破棄するときだけ実行します。通常の無効化ではdraftなどを保持します。
const dispose = () => {
  unsubscribe();
  feedback.destroy();
};
```

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
handleの`downloadDiagnostics()`は、直近100 operationのrequest ID、operation、profile ID、HTTP status、duration、error codeだけを
JSONとして明示downloadします。本文、thread ID、host principal、filename、API keyは収集しません。
導入手順とgateway SPIは`docs/redmine-integration.md`、`docs/redmine-gateway.md`を参照してください。
