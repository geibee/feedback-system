# Redmine正本Feedback導入ガイド

## 目的と構成

Redmine正本方式は、Feedbackのissue、返信、状態、証跡をRedmine issue・journal・attachment・custom fieldだけへ保存する。
Feedback PostgreSQL、object storage、host DB参照、同期worker、server-side cacheは使用しない。

利用経路は次の2つである。

- 埋め込み版: 業務アプリの既存sessionと認可を使うsame-origin gateway、およびJavaScriptプラグイン
- 拡張機能版: Chrome / Edge拡張が個人Redmine API keyでRedmine RESTへ接続

両経路は`@feedback/redmine-core`のmodel・operationと`@feedback/redmine-react`のUIを共有する。Feedback UIから書き込むのは
初回コメントと任意のスクリーンショットだけであり、返信、編集、担当、優先度、状態変更はRedmine UIで行う。

## Redmineを準備する

1. Redmine管理画面でREST APIを有効化する。
2. Feedback専用projectとtrackerを用意する。
3. 下表のissue custom fieldを作り、対象project/trackerへ割り当てる。
4. Redmineの最大attachment sizeをprofileの`capture.maximumUploadBytes`以上にする。
5. 埋め込み版では専用integration userをproject memberにし、issue閲覧・追加・attachment追加だけを許可する。
6. 拡張機能版では各利用者をproject memberにし、個人API keyを発行できるようにする。

integration userをadministratorや他projectのmemberにしない。private issueを使う場合はprivate issueの追加・閲覧権限を与える。
専用roleではprivate noteを使わない。利用者ごとのprivate note可視性が必要なら個人keyを使う拡張機能版を選ぶ。

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
| `submissionChannel` | Feedback Submission Channel | list | 任意 | `embedded` / `extension` |

field IDは環境固有のnumeric IDをprofileへ明示し、表示名から推測しない。12個のIDはprofile内で重複不可である。
`threadId`はUUID v4、`requestHash`はlowercase SHA-256、`hostResourceKey`はraw業務IDではなく認可後のopaque値を保存する。
Redmineにcustom field unique制約はないため、同じthread IDが2件以上ならconnectorはfail-closedする。

## Redmineへ保存する内容

issue descriptionには人が読める初回コメントとversion付きmetadata blockを保存する。同時に
`feedback-context-v1.json` attachmentへlocation、target、release、locale、trusted author、request hashを保存する。
スクリーンショットは`feedback-{threadId}.png`または`.webp`として保存し、SHA-256、byte size、viewportをcontextへ記録する。

thread表示は毎回Redmine RESTからissue detail、全journal、attachment metadataを読み、次を正規化する。

- notesありjournalはreply
- notesなしfield changeはactivity
- 編集済み・空notesもjournal ID順を維持
- initial descriptionと全journalから`latestReply`を再構築
- context attachmentとprimary evidenceを区別

端末へ永続化できるのはfollow/read stateとpending intentだけである。本文、journal、attachment bytesをclient cacheの正本にしない。

## 埋め込み版を導入する

1. [`redmine-gateway.md`](redmine-gateway.md)に従いgatewayを既存認証middleware配下へmountする。
2. server profileとintegration user API keyをsecret managerから設定する。
3. `@feedback/redmine-plugin`をinstallするか、self-hosted ESMを自社originへ配置する。
4. `createRedmineFeedbackPlugin()`へmount要素、profile ID、host adapter、CSRF token callbackを渡す。
5. profile read/create認可とresource認可を別々に検証する。

pluginの公開optionにはRedmine URL、API key、project/tracker/custom field ID、任意HTTP headerを渡せない。
通信先はsame-originの`/internal/feedback-redmine/v1`へ固定される。

## 拡張機能版を導入する

1. [`redmine-extension.md`](redmine-extension.md)に従いunpacked directoryまたは承認済みZIPを配布する。
2. optionsまたはmanaged policyへsecretを含まないprofileを設定する。
3. 利用者操作で業務画面originとRedmine originのpermissionを許可する。
4. 個人API keyでunlockし、対象業務画面を再読込する。

拡張機能の`hostResourceKey`はcanonical resource refから生成したopaque hashであり、raw URL queryや業務IDをcustom fieldへ保存しない。

## 検証と運用

通常の接続確認ではcurrent user、project、tracker scopeのissue一覧だけを読み、issueを作らない。最初のwrite検証は管理者が明示して
canaryまたは実投稿を行い、全custom field、context attachment、thread ID検索、証跡downloadを確認する。

repositoryの入口は次である。

```bash
bash scripts/verify-feedback.sh
```

Redmine version matrixはDocker Official Imageのdigestを`tests/redmine-conformance/images.lock.json`へ固定する。
対応下限はRedmine 5.1.12である。公式exact tagを含む5.1.12、6.0.10、6.1.3、7.0.0をdigest固定して検証する。

Redmineが唯一の正本なので、Redmine DBとfilesのbackup、restore試験、attachment retentionを運用必須とする。
plugin、gateway、拡張機能はRedmine backupを代行しない。
