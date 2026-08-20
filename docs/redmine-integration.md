# Redmine正本Feedback導入ガイド

前提条件から本番運用までの一連の手順は[`feedback-redmine-installation.md`](feedback-redmine-installation.md)を正本とする。

## 目的と構成

Redmine正本方式は、Feedbackのissue、返信、状態、証跡をRedmine issue・journal・attachment・custom fieldだけへ保存する。
Feedback専用PostgreSQL、object storage、同期worker、server-side cacheは使用しない。

利用経路はSPAへbuild時に同梱する`@geibee/redmine-plugin`とsame-origin gatewayだけである。
ブラウザ拡張機能、OIDC JWT、host session、個人Redmine API keyをSDKへ渡さない。Feedback利用者はUIから投稿、返信、
自己編集を行い、開発者はRedmineから返信、担当、優先度、状態変更を行う。両経路の内容はRedmineを正本として同じthreadへ反映する。

## Redmineを準備する

1. Redmine管理画面でREST APIを有効化する。
2. Feedback専用projectとtrackerを用意する。
3. 下表の11 issue custom fieldsを作り、対象project/trackerへ割り当てる。
4. Redmineの最大attachment sizeをprofileの`capture.maximumUploadBytes`以上にする。
5. 専用integration userをproject memberにし、issue閲覧・追加、注記追加、issue編集、attachment追加に必要な最小権限だけを許可する。
6. integration userのAPI keyをsecret managerへ保存する。

integration userをadministratorや他projectのmemberにしない。private issueを使う場合はprivate issueの追加・閲覧権限を与える。
API keyをSPA bundle、HTML、client runtime config、browser storage、server profile JSONへ保存しない。

| profile key | 推奨表示名 | 形式 | filter | 用途 |
| --- | --- | --- | --- | --- |
| `threadId` | Feedback Thread ID | text 1行 | 必須 | UUIDと冪等回収 |
| `requestHash` | Feedback Request Hash | text 1行 | 不要 | retry内容の一致確認 |
| `applicationKey` | Feedback Application | text 1行 | 必須 | application分離 |
| `environmentKey` | Feedback Environment | text 1行 | 必須 | environment分離 |
| `externalWorkspaceKey` | Feedback Workspace | text 1行 | 必須 | workspace分離 |
| `pageKey` | Feedback Page | text 1行 | 必須 | 画面別一覧 |
| `hostResourceKey` | Feedback Host Resource | text 1行 | 必須 | resource認可・filter |
| `perspectiveCode` | Feedback Perspective | text 1行 | 推奨 | 観点filter |
| `locator` | Feedback Locator | long text | 不要 | location/targetのcompact JSON |
| `submittedById` | Feedback Submitted By ID | text 1行 | 不要 | trusted投稿者ID |
| `submittedByName` | Feedback Submitted By Name | text 1行 | 不要 | 許可時だけの表示名 |

field IDは環境固有のnumeric IDをserver profileへ明示し、表示名から推測しない。11個のIDはprofile内で重複不可である。
`threadId`はUUID v4、`requestHash`はlowercase SHA-256、`hostResourceKey`はhostが選んだresource keyを保存する。
Redmineにcustom field unique制約はないため、同じthread IDが複数見つかった場合はgatewayがfail-closedする。

## Redmineへ保存する内容

issue descriptionには人が読める初回コメントと、SPAで同じthreadを開くsame-origin URLだけを保存する。Application、Environment、
Workspace、Page、Host resourceなどの値はdescriptionへ重複させない。これらのcustom fieldはRedmine APIがProfile／画面／resourceを
絞り込み、冪等回収と一覧を行うための構造化索引であり、URLからの文字列解析では代替しない。

`feedback-context-v1.json`にはlocation、target、release、locale、participant UUID、自己申告表示名、request hashと
初回自己編集用署名を保存する。旧issueのdescriptionにある`Feedback metadata v1`は読取互換のため解析するが、新規issueへは書かない。スクリーンショットは
`feedback-{threadId}.png`または`.webp`として保存し、SHA-256、byte size、viewportをcontextへ記録する。

返信は署名付きmessage markerを持つRedmine journalとして追加する。編集は元journalを上書きせず、version付きedit journalを追記し、
UIで最新版へfoldする。最初のコメントだけはRedmine descriptionの要約も最新版にし、同じPUTでedit journalを追加する。
thread表示は毎回Redmine RESTからissue detail、全journal、attachment metadataを読み直す。Redmine開発者の通常journalやfield変更も
表示する。端末へ永続化できるのはparticipant credential、自己申告名、follow/read state、draft、pending intentだけで、本文、journal、
attachment bytesをclient cacheの正本にしない。

## gatewayとSPAを接続する

1. [`redmine-gateway.md`](redmine-gateway.md)に従いgatewayをsame-originへmountする。
2. server profileとintegration user API keyをsecret managerから設定する。
3. SPAへ`@geibee/redmine-plugin`を通常のnpm依存として追加する。
4. 公開runtime configを同一originへ配置し、Reactのclient-only integration componentから
   `createRedmineFeedbackPluginControllerFromRuntimeConfig()`を呼ぶ。
5. React cleanupでloaderの`signal`を中止し、作成済みcontrollerを`destroy()`する。
6. participant発行、位置指定投稿、返信、自己編集、終了済み返信拒否を検証する。

DOMスクリーンショットはpluginが既定で接続する。Profileの`capture.enabled`は通常`true`とし、証跡を保存しない運用だけ明示的に
`false`にする。HostのCSPでは`img-src`に`data:`と`blob:`を許可する。MapLibreのWebGL canvasを確実に含める場合は
`@geibee/maplibre`のproviderをHost Adapterへ指定する。

pluginの公開optionにはRedmine URL、API key、project/tracker/custom field ID、OIDC token、任意HTTP headerを渡せない。通信先は
runtime configのsame-origin `gatewayBasePath`へ限定する。runtime configの`enabled`を配備時feature flagとし、未指定はschema違反として
fail-closedにする。host固有feature flagへ直接接続する既存consumerだけが`createRedmineFeedbackPluginController()`を使用する。

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
