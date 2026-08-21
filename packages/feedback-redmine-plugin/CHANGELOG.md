# Changelog

## Unreleased

- strictなsame-origin配備時設定`/.well-known/feedback-redmine.json`を読むruntime loaderを追加し、設定失敗時はfail-closedにした。
- runtime config取得へ既定5秒のtimeoutと`AbortSignal`を追加し、React hostの破棄後に遅延mountしないようにした。
- gateway署名participant credentialをlocalStorageへ保存し、OIDC/session/CSRF callbackに依存しない公開modeへ変更。
- 位置選択、右クリック、MapLibre target/pin provider、返信、自己編集を追加。
- Workspace scope一覧と総件数をgateway transportへ追加。
- create時のsame-origin thread URLをgatewayへ送り、Redmine issueから該当画面を開けるようにした。

- SPAのfeature flagからdynamic import、mount、無効化、再有効化を制御する`@geibee/feedback-redmine-plugin/loader`を追加。
- 無効化時の通信・購読・timer・controller所有DOMの破棄と、完全撤去用の明示的なbrowser state削除を追加。
- React 18/19をpeer dependencyに変更し、React runtime入りself-hosted ESM bundleを廃止。
- mount途中の失敗時にもstyle、container、React rootをrollbackするようにした。

## 1.0.0-alpha.1

- Shadow DOM mount facade、same-origin gateway transport、browser storage fallback、self-hosted ESM bundleを追加。
- browser配布物のsource mapを無効化し、clean buildで古いartifactを残さないようにした。
- secretや業務本文を含まない最大100件のmemory diagnosticと明示download handleを追加。
- draft/pending intentをhost principal scopeで分離し、期限切れintentを自動削除。
