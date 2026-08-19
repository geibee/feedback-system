# API互換性

## Redmine gateway・SPA contract v1（標準）

Redmine正本経路は独立した`contracts/feedback/redmine-gateway.openapi.yaml`と、保持対象の`redmine-*.schema.json`を
公開契約とする。gateway base pathは`/internal/feedback-redmine/v1`で、業務SPAと同一originに置く。
`@feedback/contracts`、`@feedback/core`、`@feedback/dom-capture`、Redmine core/UI/plugin/gatewayは同じversionを使用する。

Principalとcontext authorの`source`は`host-session`だけである。browserからRedmine URL、API key、project/tracker/custom field ID、
投稿者を指定できない。Redmine API keyはgatewayのserver-side secretであり、problem response、metric、logへ出さない。

version 1ではunknown propertyを拒否し、`ThreadSummary.latestReply`、`Thread.latestReply`、
`Attachment.primaryEvidence`をnull許容の必須fieldとする。エラーcodeは固定集合で、Redmineの401は
`redmine.invalid_api_key`へ写像する。初回createは201、同一`threadId`・`intentId`・request hashの冪等回収は200を返す。
hash不一致またはduplicate thread IDは409相当でfail-closedする。

APIまたはDTOを変更するときは、同じ変更で次を更新する。

1. `redmine-gateway.openapi.yaml`または該当JSON Schema
2. `@feedback/contracts`の生成TypeScript型
3. gateway、core、consumerのcontract test
4. この互換性文書と各package CHANGELOG

### SPA loader contract

標準入口は`@feedback/redmine-plugin/loader`の`createRedmineFeedbackPluginController()`である。公開controllerは次を持つ。

- `state`: `disabled | loading | enabled | destroyed`
- `setEnabled(boolean)`: feature flagに追従し、同値の重複操作を冪等に扱う
- `getHandle()`: enabled時だけ現在のplugin handleを返す
- `purgeLocalState()`: 現在origin・profileの端末状態だけを明示削除する
- `destroy()`: SPA teardown用の永久破棄。重複呼出しは安全

controller作成時やdisabled時にUI dynamic import、DOM、gateway通信、timer、router購読を開始しない。
load中のdisable/destroy後に遅延mountしない。`setEnabled(false)`と`destroy()`はdraft、follow、pending intentを自動削除しない。
これらの挙動を変える場合はminorな実装詳細ではなく公開lifecycle contract変更として扱う。

端末内follow stateの任意`seenJournalIds`は、非単調なjournal IDを既知集合で判定する後方互換fieldである。旧stateにない場合は
`lastSeenJournalId`を使い、次回既読更新時に集合を保存する。pending intentは`clientDraftHash`と`prepared | uncertain`を必須とし、
principal scopeで共有端末の利用者間を分離して7日超を削除する。

返信、編集、状態変更はRedmine UIだけで行い、Feedback UIのversion 1ではread-onlyである。検証対象はRedmine 5.1.12、
6.0.10、6.1.3、7.0.0で、Docker Official Imageのexact digestを固定する。

本番投入済み環境は存在しないため、削除済みbrowser extension contractや従来Feedback DBからのデータ互換性は保証対象にしない。

## Legacy Feedback Service API v1

> **Legacy Feedback Service:** `/feedback/v1`と`@feedback/react`を使う従来runtime向けで、新規導入の既定ではない。

`/feedback/v1`とlegacy `@feedback/*` 1.xは後方互換を維持する。React以外の公式境界は`@feedback/core`、OpenAPI、JSON Schemaで、
MapLibreとAdmin UIは任意packageである。

v1は1つの組織またはtrust domainごとにServiceを配備し、`applicationKey`をService全体で一意とする。共有マルチテナント化で
`tenantKey`をHostContextと全API scopeへ追加する変更はv2として扱う。直接OIDCの`feedback_permissions`はDB membershipと交差し、
membershipを越える権限を与えない。

application manifest GETの`ETag`は更新PUTの`If-Match`へそのまま渡し、412時に暗黙の再試行や上書きをしない。
threadの任意field追加や追加export形式は既存clientがunknown fieldを無視できる範囲で後方互換とする。

legacy runtimeの導入と運用は[`legacy-quickstart.md`](legacy-quickstart.md)および各文書冒頭のbannerを確認する。
