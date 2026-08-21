# API互換性

## Redmine gateway・SPA contract v1（標準）

Redmine正本経路は独立した`contracts/feedback/redmine-gateway.openapi.yaml`と、保持対象の`redmine-*.schema.json`を
公開契約とする。gateway base pathは`/internal/feedback-redmine/v1`で、業務SPAと同一originに置く。
`@geibee/feedback-contracts`、`@geibee/feedback-core`、`@geibee/feedback-dom-capture`、`@geibee/feedback-react-ui`、`@geibee/feedback-maplibre`、Redmine core/UI/plugin/gatewayは同じversionを使用する。

`1.0.0-alpha.3`では`FeedbackTargetV1`へ後方互換な`custom` variantを追加した。Canvas、Three.js、独自chartなどのhostは、
既存`FeedbackTargetResolver`から名前空間付き`provider`、安定した`targetKey`、必須のviewport相対fallback座標を返す。
現在位置は既存`FeedbackPinPositionProvider`で解決し、providerが存在しないか対象を解決できない場合はfallback座標へ表示する。
`metadata`は最大20項目のscalar値だけに限定し、認証情報や業務本文を保存しない。`custom` targetを生成するSPAは
`1.0.0-alpha.3`以降のgatewayと組み合わせる。既存4 variantと保存済みlocatorの読取動作は変更しない。

Principalとcontext authorの`source`は`participant-credential`である。SDKは非公開browser profile UUIDを採番し、gatewayがそこから導出した
公開participant UUIDとorigin/profile scopeのopaque credentialをlocalStorageへ保存する。非公開UUIDは会話応答やRedmineへ保存しない。
browserからRedmine URL、API key、project/tracker/custom field IDを指定できない。
Redmine API keyとparticipant署名鍵はgatewayのserver-side secretであり、problem response、metric、logへ出さない。

version 1ではunknown propertyを拒否し、`ThreadSummary.latestReply`、`Thread.latestReply`、
`Attachment.primaryEvidence`をnull許容の必須fieldとする。エラーcodeは固定集合で、Redmineの401は
`redmine.invalid_api_key`へ写像する。初回createは201、同一`threadId`・`intentId`・request hashの冪等回収は200を返す。
hash不一致またはduplicate thread IDは409相当でfail-closedする。

thread createの任意`threadUrl`は同一originかつ対象`threadId`を`feedbackThread` queryに持つURLだけを許可する。新規Redmine issueの
descriptionは初回コメント、添付したprimary evidenceを表示するRedmine標準thumbnail macro、CommonMarkとTextileの双方で
自動linkになるURLで構成し、従来の`Feedback metadata v1`は書き込まない。Redmine UIでは画像とURLをクリック可能にする。
旧descriptionのURL文字列は読取・初回編集互換を維持し、
初回自己編集の署名はcontext attachmentから復元する。

thread一覧の`scope`省略は従来どおりresource scopeであり、resourceKind、resourceKey、pageKeyを必須とする。
追加の`scope=workspace`はこれらを指定せず、Profileに固定されたapplication、environment、external workspace、Redmine project/tracker
全体を一覧する。一覧responseの`totalCount`は追加必須fieldである。resource cursor v1は維持し、Workspace cursor v2は異なるscopeへ
流用できない。詳細、添付、返信、編集は引き続きresource-boundで、別画面の一覧項目はHostAdapterの遷移完了後に取得する。

`Capabilities`は`canRead`、`canCreate`、`canReply`、`canEditOwn`、`stateReadOnly`を返す。`repliesReadOnly`と必須`getCsrfToken` optionは
alpha.2で廃止した。導入評価段階のalpha.1 clientとの互換性は保証しない。message create/updateはmutationごとのUUID
`Idempotency-Key`を必須とし、updateは`expectedVersion`競合を409で返す。

`Thread.messages`はinitial/replyを共通形へ正規化し、stable message ID、participant/Redmine author、最新版body、version履歴、
`canEdit`を返す。Feedback UIの編集は署名付きedit journalを追記してfoldする。Redmine UIで直接編集されたjournalは最新版と
`updated_on`を表示するが、Redmineが保持しない旧本文を推測しない。

APIまたはDTOを変更するときは、同じ変更で次を更新する。

1. `redmine-gateway.openapi.yaml`または該当JSON Schema
2. `@geibee/feedback-contracts`の生成TypeScript型
3. gateway、core、consumerのcontract test
4. この互換性文書と各package CHANGELOG

gatewayは`GET /health/live`と`GET /health/ready`を公開する。両endpointの成功bodyは`{"status":"ok"}`で、認証や
Redmine業務データを返さない。readyはprocessと起動時設定の判定であり、Redmineまでの疎通契約はops CLIの`doctor`が担う。

配備時設定`redmine-runtime-config.v1`は`schemaVersion`、`enabled`、`profileId`、root-relativeな`gatewayBasePath`だけを許可する。
`@geibee/feedback-redmine-plugin/loader`のruntime loaderは同一originから`no-store`で取得し、unknown propertyや外部URLをfail-closedで拒否する。
このschemaへsecretまたはRedmine数値IDを追加する変更は許可しない。

repository内のSPAとclean consumer検証はVite 8.2を標準とする。公開`@geibee/*` packageはViteをruntime依存または
peer dependencyに持たず、React 18または19とbundlerはhostが提供する。この標準bundlerの更新だけで公開API互換性は変更しない。

既存Redmine導入は`redmine-installation-manifest.v1`を名前ベースの入力、`redmine-provision-plan.v1`と
`redmine-provision-result.v1`をreview／実ID出力の契約とする。installation manifestへ環境固有IDやsecretを追加せず、
provisionerのapplyは同じplan digestを必須にする。

### SPA loader contract

標準入口は`@geibee/feedback-redmine-plugin/loader`の`createRedmineFeedbackPluginControllerFromRuntimeConfig()`である。
host feature flagを直接制御する場合は`createRedmineFeedbackPluginController()`も維持する。公開controllerは次を持つ。
runtime config取得は既定5秒でtimeoutし、`signal`でhost lifecycleから中止できる。callerによる中止はavailability errorとして
`onUnavailable`へ通知せず、timeoutと取得失敗だけを通知する。

- `state`: `disabled | loading | enabled | destroyed`
- `setEnabled(boolean)`: feature flagに追従し、同値の重複操作を冪等に扱う
- `getHandle()`: enabled時だけ現在のplugin handleを返す
- `registerMapLibreMap(map)`: 遅延生成されたMapLibre mapをWebGL証跡対象へ登録し、解除関数を返す。disabled中の登録は次のmountへ引き継ぐ
- `purgeLocalState()`: 現在origin・profileの端末状態だけを明示削除する
- `destroy()`: SPA teardown用の永久破棄。重複呼出しは安全

enabled時のplugin handleも`registerMapLibreMap(map)`を持つ。controller版はdisable/enableをまたいで登録を保持し、
handle版は現在のmountだけへ登録する。どちらも戻り値を複数回呼んでも安全に解除する。

controller作成時やdisabled時にUI dynamic import、DOM、gateway通信、timer、router購読を開始しない。
load中のdisable/destroy後に遅延mountしない。`setEnabled(false)`と`destroy()`はdraft、follow、pending intentを自動削除しない。
これらの挙動を変える場合はminorな実装詳細ではなく公開lifecycle contract変更として扱う。

標準gatewayはprofile fileと、`clientProfile`を埋め込んだenv-onlyのprofile JSONのどちらか一方を受け付ける。
profile JSONは公開runtime configではなくserver-side設定であり、API keyやparticipant署名鍵を含めない。

端末内follow stateの任意`seenJournalIds`は、非単調なjournal IDを既知集合で判定する後方互換fieldである。旧stateにない場合は
`lastSeenJournalId`を使い、次回既読更新時に集合を保存する。pending intentは`clientDraftHash`と`prepared | uncertain`を必須とし、
principal scopeで共有端末の利用者間を分離して7日超を削除する。

返信と自己編集はFeedback UIから行える。状態、担当者、優先度はRedmine UIだけで変更し、Feedback UIはそのjournalを表示する。
Redmine UIはlegacy `@geibee/react`へ依存せず、同版のlauncher、対象選択、右クリックmenu、独立composer／一覧／drawer、pin、
明示的な証跡表示のUXをRedmine port上で実装する。レビュー導入、投稿warn/deny、reaction、UIからの状態変更は移植対象外である。
検証対象はRedmine 5.1.12、
6.0.10、6.1.3、7.0.0で、Docker Official Imageのexact digestを固定する。

本番投入済み環境は存在しないため、削除済みbrowser extension contractや従来Feedback DBからのデータ互換性は保証対象にしない。

## Legacy Feedback Service API v1

> **Legacy Feedback Service:** `/feedback/v1`と`@geibee/react`を使う従来runtime向けで、新規導入の既定ではない。

`/feedback/v1`とlegacy `@geibee/*` 1.xは後方互換を維持する。React以外の公式境界は`@geibee/feedback-core`、OpenAPI、JSON Schemaで、
MapLibreとAdmin UIは任意packageである。

v1は1つの組織またはtrust domainごとにServiceを配備し、`applicationKey`をService全体で一意とする。共有マルチテナント化で
`tenantKey`をHostContextと全API scopeへ追加する変更はv2として扱う。直接OIDCの`feedback_permissions`はDB membershipと交差し、
membershipを越える権限を与えない。

application manifest GETの`ETag`は更新PUTの`If-Match`へそのまま渡し、412時に暗黙の再試行や上書きをしない。
threadの任意field追加や追加export形式は既存clientがunknown fieldを無視できる範囲で後方互換とする。

legacy runtimeの導入と運用は[`legacy-quickstart.md`](legacy-quickstart.md)および各文書冒頭のbannerを確認する。
