# Changelog

## 2.0.0-alpha.3 thread参照拡張 - 2026-09-07

- ThreadのallOfとadditionalProperties=falseの矛盾を解消し、messagesを含む既存応答のschema検証を固定した。
- opt-inのthreadReferenceと共通要求headerを追加した。旧v2の応答fieldとRedmine v1を維持する。
- DBレス・重複排除best-effort、参照の認可非代替性、scope／audience binding、失効時のfallback禁止を固定した。
- provider profileへ任意の独立threadReferenceKeyRingを追加し、uniqueThreadLookup=false（best-effort検索）を許可した。visible duplicate拒否は維持する。
- HTTP client、controllerのscope別端末state／pending intent、3 Connectorの直接取得portを導入した。React／Web Componentは共通controller経由で利用する。

## 未リリース - 2026-09-06 セキュリティ修正

- server-only Envelopeへ任意の`initialBodyHash`を追加し、生成型を同期した。新規作成の既知本文だけを署名し、hashのない旧Envelope／first-write結果不明からの補修ではprovider本文を本人の検証済み本文へ昇格しない。
- profileの許可集合照会と自己編集時のread／revise認可を明記した。browser wire DTOとRedmine v1契約は変更しない。
- 旧DB保存版の互換・移行機能は提供しない。Redmine v1 ticket形式の互換はDB版とは独立して保持する。

## 1.0.0-rc.1 Feedback v2 contract 2.0.0-alpha.2 - 2026-09-02

- Backlog初回release candidateは既存の公開wire／domain契約を変更せず、provider能力差を既存capabilityとoperation保証で表現した。
- attachment read／uploadを`unsupported`として縮退し、Backlog固有DTO、credential、provider内部IDを公開契約へ追加していない。

## 1.0.0-alpha.7 Feedback v2 contract 2.0.0-alpha.2 - 2026-09-01

- `public-profile` browserがparticipant credentialを取得できるsame-origin発行endpointを追加した。
- すべてのunsafe operationへ実装と同じ必須`X-Feedback-CSRF: 1` headerを明記した。
- signed grant Bearerとpublic participant credential headerをOpenAPI security schemeへ明記した。
- intent回収の`requestHash`はURLへ含めず、既存OpenAPIどおり`X-Feedback-Request-Hash`必須headerへ統一した。
- 署名attachment markerへ必須`messageId`を追加し、provider attachmentをthread内messageへ束縛した。
- `resource.key`の実装上限をOpenAPIどおり512文字へ統一した。

## 1.0.0-alpha.7 Phase 2 contract freeze - 2026-08-31

- v2 OpenAPIを`2.0.0-alpha.1`へ進め、intent回収のthread／resource scope、strict command DTO、provider timeout 504／unavailable 502／media type 415を固定した。
- authorization targetをprofile／workspace／resourceへ分離し、remote authorization request／decisionを同じtargetへ束縛した。
- message markerへreply／revision event、participant、body hashを追加し、server-only attachment mapping schemaを追加した。
- provider profileへcreation fieldとmetadata byte上限を追加し、operation保証をprovider fixtureで固定した。
- Jira Cloud REST v3のissue／comment／property／attachment／timeout回収をsanitized fixture化した。

## 1.0.0-alpha.7 Phase 1 draft - 2026-08-31

- provider非依存のFeedback Gateway v2 OpenAPIと生成型を追加した。
- domain、Envelope、message marker、projection、provider profile、service settings、authorization schemaと生成型を追加した。
- browser向け`./v2`とserver-only `./v2/server`を分離し、`ProviderRef`とprovider内部IDをbrowser契約へ公開しない境界を固定した。
- workspace／resource discovery、operation別回復保証、独立attachment upload権限、typed intent回収、projection再検証のfreeze候補とnegative fixtureを追加した。

## 1.0.0-alpha.7 - 2026-08-30

- `FeedbackHostContextV1.locale`の任意性と`FeedbackTargetV1`の5種類のunionを維持し、alpha.3〜alpha.6との公開型互換を固定した。
- Redmineで使わないFeedback Service OpenAPI、token exchange、manifest／webhook schema、生成型を削除した。
- runtime configへplain textの管理者案内、installation manifestへ任意のレビュー観点を後方互換で追加。
- Redmine投稿option取得endpointと、任意の親チケット・期限・重要度をcreate契約へ追加。

## 2026-08-21

- `FeedbackTargetV1`へ名前空間付きprovider、安定target key、画面fallback座標、scalar metadataを持つ
  `custom` variantを後方互換で追加。
- managed RedmineのREST検査、15件の手動確認、承認digest、生成profileを固定shapeで表す
  `redmine-inspection-report.v1` schemaとTypeScript型を追加。

## 2026-08-20

- Redmine gatewayのlive/ready health endpoint、配備時runtime config、名前ベースinstallation manifest、provision plan/result schemaを追加。
- runtime configのgateway path制約をbrowser側validatorと同期した。
- Redmine thread一覧へ後方互換なWorkspace scopeと`totalCount`を追加し、resource cursor v1と分離したWorkspace cursorを定義。
- Redmine thread createへ、同一origin・対象threadへ限定した任意`threadUrl`を追加。

## 2026-08-19

- Redmine公開participant credential、返信・自己編集、会話message、閉鎖状態の契約を追加し、旧host-session/CSRF契約を削除。
- 本番導入前の契約整理としてChrome / Edge拡張機能用profile・message・client state・operation schemaを削除し、
  Redmine gatewayとSPAのHTTP契約へ一本化。
- Redmine principalとcontext authorのsourceをsame-origin gatewayが注入する`participant-credential`だけに限定。
- Redmineを業務データ正本とするgateway OpenAPI、client profile、host resource、context attachment契約を追加。
- Redmine専用生成TypeScript型をlegacy Feedback Service生成型から分離して追加。
- Redmine profile/current user/thread/list/attachment responseをunknown property拒否のstrict schemaとして追加。
- thread/listの`latestReply`とattachmentの`primaryEvidence`をnull許容の必須fieldとして固定し、401 error codeへ
  `redmine.invalid_api_key`を追加。
- スレッド一覧へ更新順・作成順、観点、担当者、優先度、ラベル、証跡、本文検索のfilterを後方互換で追加。
- スレッドへ担当者・優先度・ラベル、メッセージへ固定リアクションを追加。
- 参加スレッドへの未読返信件数と既読更新APIを追加。
- 全コメント版履歴、トリアージ・状態・リアクション履歴、証跡画像、SHA-256 manifestを含む`evidence-package` exportを追加。

## 2026-08-14

- 直接OIDC access tokenで `feedback_permissions`を必須とし、DB membershipと常に交差する認可契約を明記。
- workspace membershipを権限の正本とし、application権限を同一application内のworkspace権限の和集合として同期するように変更。PATCHを含め、workspace最後のadmin権限除去を拒否。

## 2026-08-13

- tenant/application/environment/workspace/membershipをCI/CDから同期するinstallation manifest v1 schemaを追加。
- application manifestのGET応答へETagを追加し、CI/CDの宣言的同期が更新前の版を`If-Match`で固定できるようにした。

## 2026-08-10

- 管理画面からレビュー状態を一度で作成し、対象画面と観点を編集できるよう、セッション作成へ任意の `status`、PATCHへ任意の `scopes` / `perspectives` を後方互換で追加。
- セッション／スレッド状態を文字列型として明示し、Go HTTPサーバーで`status`クエリを束縛できない生成不具合を修正。

## 1.0.0-alpha.2

- 日次フル＋差分の証跡バックアップ方針、実行履歴、認可付きZIPダウンロードを追加。
- Connector Protocol v1と通知コネクタcatalog／workspace設定APIを追加。
- 従来の単一Webhook設定をdeprecatedとし、互換APIとして維持。

## 1.0.0-alpha.1

- Feedback Service v1 の専用 OpenAPI と TypeScript 型を追加。
- application manifest、location、target、webhook event の JSON Schema を追加。
