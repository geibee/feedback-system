# API互換性

`/feedback/v1` と `@feedback/*` 1.xの公開APIは後方互換を維持する。React以外の公式境界は
`@feedback/core`、OpenAPI、JSON Schema。MapLibreとAdmin UIは任意packageである。

`FeedbackHostAdapter.subscribe`は任意メソッドとして追加し、既存adapterの実装を壊さない。実装したhostでは
route／workspace変更をReact Providerへ通知でき、未実装時は従来どおり初回取得と明示的`refresh`を利用する。
transportのcontext取得メソッドへ追加した`AbortSignal` optionも任意で、既存transport実装はそのまま適合する。
これらはHTTP API／DTO／JSON Schemaを変更しないため、OpenAPIと生成契約型の更新対象ではない。

v1は1つの組織またはtrust domainごとにServiceを配備し、`applicationKey`をService全体で一意とする。
`tenantKey`をHostContextとAPI scopeへ追加する共有マルチテナント化は、URL・DTO・DB一意制約を同時に変更するため
v2の契約変更として扱う。v1 clientへtenant選択を暗黙に追加しない。

application manifestのGET応答へ`ETag`を追加する変更は、既存bodyを変えない後方互換のheader追加である。
宣言的同期clientはGETで得た値を更新PUTの`If-Match`へそのまま渡し、412時に暗黙の再試行や上書きをしない。

直接OIDC access tokenの `feedback_permissions`必須化は認可契約と実装を一致させるsecurity hardeningである。
従来受理していたclaimなしのtokenは401になるため、更新前にIdPのOAuth scopeとaccess token claim mappingを
追加する。permissionはDB membershipと交差するため、claimへの移行で既存membershipを越える権限は生じない。

workspace membershipを権限の正本とし、application membershipは同一application内のworkspace permissionの和集合として
扱う。Admin APIの作成・更新・削除は両方を同一transactionで同期し、最後のworkspace admin権限をPATCHまたはDELETEで
失わせる操作は409を返す。PATCHへの409追加は既存の成功応答やrequest DTOを変えない後方互換の安全性強化である。

スレッドの`assignee`、`priority`、`labels`とメッセージの`reactions`は任意fieldとして追加する。既存clientは
fieldを無視でき、未設定時の従来応答を維持する。スレッド一覧のsortを省略した場合は`updated_desc`を既定とし、
従来の作成日時降順が必要なclientは`sort=created_desc`を明示する。

未読返信APIは、認証主体が作成または返信したスレッドへ別の利用者が投稿したメッセージだけを数える。
状態変更やリアクションは未読件数へ含めない。リアクションは`thumbs_up`、`check`、`eyes`、`question`の固定集合とし、
PUT／DELETEを冪等に扱う。

`evidence-package` exportは既存のCSV／XLSXへ影響しない追加形式である。正規化CSVと画像の対応関係および
manifestの検証方法は[`evidence-export.md`](evidence-export.md)を正本とする。認証・認可監査ログは含めない。

registry公開前は `npm pack` のtarballをcleanなReact 18/19 + Vite consumerへinstallして検証する。
公開時は同じpackage versionとService image tagをnpm互換registry/OCI registryへ配置する。

## Redmine gateway・browser contract v1

Redmine正本経路は従来の`/feedback/v1`へendpointを追加せず、独立した
`contracts/feedback/redmine-gateway.openapi.yaml`と`redmine-*.schema.json`を公開契約とする。
gateway base pathは`/internal/feedback-redmine/v1`であり、業務アプリケーションと同一originに置く。
`@feedback/redmine-core`、React UI、plugin、gateway、Chrome / Edge拡張は同じversionを使用する。

version 1ではunknown propertyを拒否し、`ThreadSummary.latestReply`、`Thread.latestReply`、
`Attachment.primaryEvidence`をnull許容の必須fieldとする。エラーcodeは固定集合で、Redmineの401は
`redmine.invalid_api_key`へ写像する。成功response、extension message、端末内follow/pending/draft messageも
JSON Schemaで閉じており、追加fieldは契約変更としてOpenAPI、生成TypeScript型、互換性文書を同時更新する。
extension unlock成功responseの任意`customFieldValidation`は、project内に検証対象issueがない場合を
`not-yet-proven`としてoptions UIへ表示するための後方互換fieldである。
端末内follow stateの任意`seenJournalIds`は、非単調なjournal IDを既知ID集合で判定するための後方互換fieldである。
旧stateにこのfieldがない場合は`lastSeenJournalId`による従来判定を維持し、次回既読更新時に集合を保存する。
extension専用`diagnostic.download.v1`は追加operationであり、既存messageを変更しない。返す最大100件のentryは
request ID、operation、profile ID、HTTP status、duration、error codeだけに閉じ、browser再起動後へ永続化しない。
Redmine client state v1のpending intentはRedmineへ保存する`requestHash`と区別して`clientDraftHash`を使用し、
`prepared|uncertain`を必須にする。intent/draft operationは必須`principalScopeHash`で共有端末の利用者間を分離し、7日超のintentを削除する。

初回createは201、同一`threadId`・`intentId`・request hashの冪等回収は200を返す。同じthread IDでhashが異なる場合、
または同じcustom field値が複数issueに存在する場合は409相当でfail-closedする。返信・編集・状態変更はRedmine UIだけで行い、
Feedback UIのversion 1ではread-onlyである。

検証対象と対応下限はRedmine 5.1.12、6.0.10、6.1.3、7.0.0である。各Docker Official Imageの
exact tagとmulti-platform manifest digestを固定し、`scripts/check-feedback-redmine-conformance.sh`で4版すべてを検証する。
