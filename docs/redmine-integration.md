# Redmine正本Feedback導入ガイド

## 目的と構成

Redmine正本方式は、Feedbackのissue、返信、状態、証跡をRedmine issue・journal・attachment・custom fieldだけへ保存する。
Feedback専用PostgreSQL、object storage、同期worker、server-side cacheは使用しない。

利用経路はSPAへbuild時に同梱する`@feedback/redmine-plugin`と、既存session認証配下のsame-origin gatewayだけである。
ブラウザ拡張機能や個人Redmine API keyを利用者へ配布しない。Feedback UIから書き込むのは初回コメントと任意の
スクリーンショットだけで、返信、編集、担当、優先度、状態変更はRedmine UIで行う。

## Redmineを準備する

1. Redmine管理画面でREST APIを有効化する。
2. Feedback専用projectとtrackerを用意する。
3. 下表の11 issue custom fieldsを作り、対象project/trackerへ割り当てる。
4. Redmineの最大attachment sizeをprofileの`capture.maximumUploadBytes`以上にする。
5. 専用integration userをproject memberにし、issue閲覧・追加・attachment追加に必要な最小権限だけを許可する。
6. integration userのAPI keyをsecret managerへ保存する。

integration userをadministratorや他projectのmemberにしない。private issueを使う場合はprivate issueの追加・閲覧権限を与える。
API keyをSPA bundle、HTML、client runtime config、browser storage、server profile JSONへ保存しない。

| profile key | 推奨表示名 | 形式 | filter | 用途 |
| --- | --- | --- | --- | --- |
| `threadId` | Feedback Thread ID | text 1行 | 必須 | UUIDと冪等回収 |
| `requestHash` | Feedback Request Hash | text 1行 | 不要 | retry内容の一致確認 |
| `applicationKey` | Feedback Application Key | text 1行 | 必須 | application分離 |
| `environmentKey` | Feedback Environment Key | text 1行 | 必須 | environment分離 |
| `externalWorkspaceKey` | Feedback External Workspace Key | text 1行 | 必須 | workspace分離 |
| `pageKey` | Feedback Page Key | text 1行 | 必須 | 画面別一覧 |
| `hostResourceKey` | Feedback Host Resource Key | text 1行 | 必須 | resource認可・filter |
| `perspectiveCode` | Feedback Perspective | text 1行 | 推奨 | 観点filter |
| `locator` | Feedback Locator | long text | 不要 | location/targetのcompact JSON |
| `submittedById` | Feedback Submitted By ID | text 1行 | 不要 | trusted投稿者ID |
| `submittedByName` | Feedback Submitted By | text 1行 | 不要 | 許可時だけの表示名 |

field IDは環境固有のnumeric IDをserver profileへ明示し、表示名から推測しない。11個のIDはprofile内で重複不可である。
`threadId`はUUID v4、`requestHash`はlowercase SHA-256、`hostResourceKey`はraw業務IDではなく認可後のopaque値を保存する。
Redmineにcustom field unique制約はないため、同じthread IDが複数見つかった場合はgatewayがfail-closedする。

## Redmineへ保存する内容

issue descriptionには人が読める初回コメントとversion付きmetadata blockを保存する。同時に`feedback-context-v1.json`へ
location、target、release、locale、host-session由来のauthor、request hashを保存する。スクリーンショットは
`feedback-{threadId}.png`または`.webp`として保存し、SHA-256、byte size、viewportをcontextへ記録する。

thread表示は毎回Redmine RESTからissue detail、全journal、attachment metadataを読み直す。端末へ永続化できるのは
follow/read stateとpending intentだけで、本文、journal、attachment bytesをclient cacheの正本にしない。

## gatewayとSPAを接続する

1. [`redmine-gateway.md`](redmine-gateway.md)に従いgatewayを既存認証middleware配下へmountする。
2. server profileとintegration user API keyをsecret managerから設定する。
3. SPAへ`@feedback/redmine-plugin`を通常のnpm依存として追加する。
4. 単一integration moduleで`createRedmineFeedbackPluginController()`を作り、hostのfeature flagを`setEnabled()`へ接続する。
5. profile read/create認可とresource認可を別々に検証する。

pluginの公開optionにはRedmine URL、API key、project/tracker/custom field ID、任意HTTP headerを渡せない。通信先はsame-originの
`/internal/feedback-redmine/v1`へ固定する。feature flag未指定時は有効を既定とする。

`setEnabled(false)`は通信、polling、購読、React rootとcontroller所有mountを破棄し、再有効化できる。draft、follow、
pending intentは保持する。完全撤去では先に`purgeLocalState()`を明示実行し、integration module、npm依存、gateway mountを削除する。
Redmineデータは削除しない。

## 検証と運用

通常の接続確認ではcurrent user、project、tracker scopeのissue一覧だけを読み、issueを作らない。最初のwrite検証は管理者が明示して
canaryまたは実投稿を行い、11 fields、context attachment、thread ID検索、証跡downloadを確認する。

```bash
npm run smoke:redmine
bash scripts/verify-feedback.sh
```

Redmine version matrixはDocker Official Imageのdigestを固定し、5.1.12、6.0.10、6.1.3、7.0.0を検証する。
Redmineが唯一の正本なので、Redmine DBとfilesのbackup、restore試験、attachment retentionを運用必須とする。
pluginとgatewayはRedmine backupを代行しない。

本番投入済みFeedback環境はないため、旧DBからの移行CLI、dual-write、read-only期間、rollback用データ変換は対象外である。
