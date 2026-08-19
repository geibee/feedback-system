# @feedback/redmine-plugin

業務アプリケーションへframework非依存で埋め込むFeedback pluginです。`createRedmineFeedbackPlugin()`へmount先、
profile ID、host adapter、業務アプリケーションのCSRF token callbackを渡します。

Redmine API key、Redmine URL、project/tracker/custom field IDは公開optionに存在しません。通信先は同一originの
relative gateway pathだけで、`credentials`と`mode`を`same-origin`へ固定します。

`dist/feedback-redmine-plugin-with-react.es.js`はReact runtimeを含むself-hosted ESM bundleです。remote CDNを必要としません。
配布buildはJavaScript/TypeScript source mapを含めず、Shadow DOM内へ共通styleを閉じ込めます。
handleの`downloadDiagnostics()`は、直近100 operationのrequest ID、operation、profile ID、HTTP status、duration、error codeだけを
JSONとして明示downloadします。本文、thread ID、host principal、filename、API keyは収集しません。
導入手順とgateway SPIは`docs/redmine-integration.md`、`docs/redmine-gateway.md`を参照してください。
