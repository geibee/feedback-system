# Changelog

## 2026-08-19

- Redmineを業務データ正本とするgateway OpenAPI、共通operation、client/extension profile、host resource、context attachment契約を追加。
- Redmine専用生成TypeScript型をlegacy Feedback Service生成型から分離して追加。
- Redmine profile/current user/thread/list/attachment response、client state message、evidence/attachment Port messageを
  unknown property拒否のstrict schemaとして追加。
- extension unlock成功responseへ非破壊接続確認の`customFieldValidation`を任意fieldとして追加。
- 端末内follow stateへ非単調なRedmine journal IDの未読判定に使う任意`seenJournalIds`を追加。
- extension optionsからmemory診断を明示downloadする`diagnostic.download.v1` messageを追加。
- pending intentを`clientDraftHash`・`prepared|uncertain`へ固定し、intent/draft messageをprincipal scopeへ束縛。
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
