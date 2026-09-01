# Phase 4 Gate

確認日: 2026-09-01

契約freeze: `feedback-v2-contract-2.0.0-alpha.1`

## 判定

**PASS**。rendererのscoped test、実Chrome smoke、正規`bash scripts/verify-feedback.sh`がすべて成功した。Phase 5のFeedback Service／provider統合と外部Jira writeは開始しない。

Phase 4開始時のOpenAPI、v2 schema、server／browser port、controller contract、golden snapshotは`contract-freeze.sha256`へ記録し、Gate検証で一致を要求する。renderer都合の契約変更は行わない。

## React renderer

- `@geibee/feedback-react`は`useSyncExternalStore`で`FeedbackControllerSnapshot`を購読し、利用者操作を`FeedbackControllerCommand`へ変換する。
- HTTP、provider DTO、browser storage、polling、intentの自動再write判断を持たない。
- launcher／modal dialog、thread一覧／詳細、follow／unread、draft、target／capture、navigation、pending intent回収をsnapshotから描画する。
- 既存`@geibee/feedback-redmine-react`はv1 exportを維持し、v2向けに汎用rendererを同一参照で公開する`RedmineFeedbackControllerOverlay`互換wrapperを追加する。
- Phase 0で固定した既存Redmine UI characterizationを引き続き実行する。

## Web Componentとplugin

- `<geibee-feedback>`はopen Shadow DOMを使用し、標準renderer packageはReact、React DOM、provider packageへ依存しない。
- framework非依存`createFeedbackPlugin`がcontroller factory、scope付きconnect、mount、refresh、thread表示、購読解除、destroyを所有する。
- 同一Elementへの二重mountを拒否し、destroyは冪等、destroy後の遅延command失敗／snapshotをhost callbackへ渡さず、同じmountへ再mountできる。
- DOMは`textContent`と`addEventListener`で構築し、`innerHTML`、inline event handler、`eval`、`new Function`を使用しない。
- strict CSPでは`styleNonce`を指定でき、`unstyled`でhost管理stylesheetへ切り替えられる。組込みstyleはShadow DOM内に閉じる。
- modal dialogはlabel、live region、busy state、Escape close、Tab focus loop、open時focus、close後launcher focus復帰を持つ。

## vanilla browser E2E

`feedback-web-component-vanilla-fixture`をViteでbuildし、digest固定のPlaywright Chromium containerで次を検証する。

- React runtimeをbundleへ含めない。
- strict Content Security PolicyでCSP違反を出さない。
- hostile host CSSがShadow DOM内のbutton／dialogへ侵入しない。
- launcher、dialog、thread選択、draft、refresh、Escape、focus復帰が実browserで動作する。
- destroyでDOMと購読を同期的に切り離し、遅延snapshotを無視して再mountできる。

## 対象外

- rendererからproviderへの直接接続
- v2 write commandのID／request hash生成
- provider acceptanceとReact／Web Component共通の実provider suite
- Feedback ServiceとConnectorのproduction composition
- Jira Cloud development siteへのdeploy、install、issue／comment／attachment write

上記はPhase 5の統合作業であり、このGateでは実行しない。API／DTOとserver設定を変更していないため、OpenAPI、生成型、`docs/environment-variables.md`の変更はない。

## 検証記録

2026-09-01に次を実行した。

- `bash scripts/check-feedback-phase4.sh`: PASS。controller 10件、React renderer 7件、Web Component 7件、Redmine React 25件、vanilla fixture typecheck、実Chrome smokeが成功した。
- `bash scripts/verify-feedback.sh`: skip環境変数を指定せずに実行してPASS。clean `npm ci`、Phase 0〜4、React 18／19 tarball consumer、Redmine 5.1.12／6.0.10／6.1.3／7.0.0 conformance、browser smoke、release／publish／container platform検証が成功した。
- `apps/feedback-redmine-demo`は既存の`--passWithNoTests`によりtest fileなしで終了する。この結果をテスト成功件数には含めず、buildとbrowser smokeで検証した。

Jira Cloud development siteへのdeploy、install、issue／comment／attachment writeは実行していない。
