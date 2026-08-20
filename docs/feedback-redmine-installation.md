# Feedback Redmine導入・運用手順

この文書は、ローカル評価から既存Redmineへの導入、本番配備、検証、更新、バックアップ、障害調査までの標準手順である。
ローカル評価環境の自動構築と顧客Redmineの変更は別の手順であり、顧客環境でローカル用bootstrapを実行してはならない。

## 1. 対応バージョンと前提条件

標準構成は、業務SPAへ組み込む`@feedback/redmine-plugin`、same-originのFeedback Redmine gateway、Redmineからなる。
thread、返信、状態、添付ファイル、custom fieldの唯一の正本はRedmineであり、Feedback専用DBやobject storageは使用しない。

検証対象は次のとおりである。

- Redmine 5.1.12、6.0.10、6.1.3、7.0.0
- React 18または19
- Node.js 22.12以上25未満
- Docker EngineとDocker Compose v2（ローカル評価およびOCI imageの検証時）
- Redmine REST APIを有効化できる管理権限
- 本番ではTLSを終端し、SPAとgatewayを同じoriginで公開できるreverse proxy
- Redmine DBと`files`を同じ時点で保存・復元できる運用権限

ローカル評価はRedmine 7.0.0とPostgreSQL 17.6のdigest固定imageを使用する。本番Redmineをこれらのversionへ変更するものではない。
Redmine pluginはインストールせず、RailsやRedmine DBへgatewayから直接接続しない。gatewayが使うのは専用integration userのREST API keyだけである。

公開participant modeでは、同じoriginへ到達できる利用者が同じProfile内の投稿を閲覧・作成・返信できる。participant credentialは
自己編集の所有確認であり、実在人物の認証ではない。社内利用者等へ公開範囲を限定する場合はreverse proxyまたは上位gatewayで外部認証を必須にする。

## 2. ローカル評価環境の導入

source checkoutでは次の一コマンドで、必要なpackageとgateway/demo imageをbuildし、PostgreSQL、Redmine、provisioner、gateway、
デモSPAを順に起動する。

```bash
npm ci
npm run feedback:redmine:local
```

配布済みのreleaseを使う場合は、承認済みregistryとOCI registryへ同じversionのartifactを公開したうえで次を実行する。

```bash
npx @feedback/redmine-ops@<version> local up
```

既定のデモは`http://127.0.0.1:4173`、Redmine管理画面は`http://127.0.0.1:3001`である。別portは
`--demo-port 14173 --redmine-port 13001`で指定できる。全portはloopbackだけへbindする。

初回起動時に`.feedback-redmine`へ次を生成する。

- 推測不能なDB password、Redmine secret key base、participant署名鍵
- 専用project、tracker、2 status、priority、最小権限role、integration user、11 custom fields
- 実際の数値IDを持つclient/server profileと公開runtime config
- integration API keyとランダム化したRedmine管理者password

secretとprofileを含むstate directoryは0700、secret fileは0600で作成する。管理者資格情報に既定値はない。

```bash
node packages/feedback-redmine-ops/dist/cli.js local credentials
node packages/feedback-redmine-ops/dist/cli.js local status
node packages/feedback-redmine-ops/dist/cli.js local logs
node packages/feedback-redmine-ops/dist/cli.js local down
```

release版では先頭を`npx @feedback/redmine-ops@<version>`へ置き換える。状態を別directoryに置く場合は全commandへ
`--state-dir /absolute/path`を付ける。直接Redmine公式imageを起動すると初期値`admin` / `admin`が使われる場合があるが、
このツールは初回provisionで管理者passwordをランダム化する。ツールを経由しない評価環境では初回ログイン直後に必ず変更する。

ローカルデータを消す操作は明示確認を要求する。

```bash
feedback-redmine local reset --yes
```

`reset`は対象state directoryから導出した専用Compose projectのvolumeだけを削除する。本番や既存Redmineには使用しない。

## 3. 既存Redmineの準備

### 3.1 変更方式を選ぶ

既存Redmine instanceへの導入は、次のいずれかを選ぶ。

1. 専用projectを新設できる場合: 同梱provisionerのplanを実行し、競合とdigestをレビューしてからapplyする。
2. 既存projectや組織共通roleを使う場合: 管理画面で手動設定し、RESTの`inspect`とRails側planで差分を確認する。

provisionerは同名の既存projectを無断で採用しない。Feedback管理markerがないproject、形式や公開範囲が違うcustom field、
権限が多い同名role、属性が違う同名user、異なるworkflowを競合として停止する。競合を自動上書きするoptionはない。

[`examples/feedback-redmine-installation.json`](examples/feedback-redmine-installation.json)を作業用の安全な場所へコピーし、名称とscopeを編集する。
manifestは名前ベースであり、数値ID、API key、password、署名鍵を記載しない。`redmineBaseUrl`は本番ではHTTPSだけを許可する。

### 3.2 自動planとapply

provisionerを配布artifactから抽出する。

```bash
feedback-redmine provision extract --output /secure/feedback-redmine/provision.rb
```

Redmine applicationと同じversionのRails実行環境へ`provision.rb`とmanifestをread-onlyで配置し、書込可能かつ非公開の出力directoryを用意する。
最初は必ず`plan`を実行する。

```bash
RAILS_ENV=production bundle exec rails runner \
  /secure/feedback-redmine/provision.rb plan \
  /secure/feedback-redmine/installation.json \
  /secure/feedback-redmine/output
```

`provision-plan.json`の`operations`、`conflicts`、Redmine version、`planDigest`を別の担当者も確認する。`conflicts`が1件でもある場合は
applyできない。設定を手動で整えるか、manifestの専用名称を変更してplanをやり直す。

承認した同じdigestだけをapplyへ渡す。

```bash
RAILS_ENV=production bundle exec rails runner \
  /secure/feedback-redmine/provision.rb apply \
  /secure/feedback-redmine/installation.json \
  /secure/feedback-redmine/output \
  <reviewed-planDigest>
```

applyはREST APIを有効化し、必要な設定を名前ベースで作成または厳密一致する既存設定だけを再利用する。出力される
`client-profile.json`、`server-profile.json`、`runtime-config.json`、`provision-result.json`には環境固有の実IDが入る。
`redmine-api-key`は唯一のsecret出力であり、secret managerへ移したら作業directoryから安全に削除する。

`--local-evaluation`はproject identifierが`feedback-local`の場合だけ使えるローカル専用optionである。顧客Redmineで指定してはならない。
旧`infra/redmine/bootstrap.rb`や固定ID前提のbootstrapも顧客Redmineでは実行しない。

### 3.3 手動で作る11個のcustom field

すべて「チケット」のカスタムフィールドとして作成し、Feedback専用project、Feedback tracker、integration roleだけへ割り当てる。
「全プロジェクト向け」は無効にする。表のfilterが「有効」のfieldだけフィルタおよび検索を有効にする。

| server profile key | 正確な名称 | Redmine形式 | filter | 用途 |
| --- | --- | --- | --- | --- |
| `threadId` | Feedback Thread ID | テキスト（1行） | 有効 | thread検索と冪等回収 |
| `requestHash` | Feedback Request Hash | テキスト（1行） | 無効 | retry内容の一致確認 |
| `applicationKey` | Feedback Application | テキスト（1行） | 有効 | application scope |
| `environmentKey` | Feedback Environment | テキスト（1行） | 有効 | environment scope |
| `externalWorkspaceKey` | Feedback Workspace | テキスト（1行） | 有効 | workspace scope |
| `pageKey` | Feedback Page | テキスト（1行） | 有効 | 画面別一覧と遷移 |
| `hostResourceKey` | Feedback Host Resource | テキスト（1行） | 有効 | resource境界と詳細取得 |
| `perspectiveCode` | Feedback Perspective | テキスト（1行） | 有効 | 観点filter |
| `locator` | Feedback Locator | 長いテキスト | 無効 | target/locationのcompact JSON |
| `submittedById` | Feedback Submitted By ID | テキスト（1行） | 無効 | participant ID |
| `submittedByName` | Feedback Submitted By Name | テキスト（1行） | 無効 | 自己申告表示名 |

数値IDはRedmine環境固有である。provisionerの`provision-result.json`を正本にするか、管理者API keyを一時的に環境変数へ入れて
read-only inspectを実行する。

```bash
export FEEDBACK_REDMINE_INSPECT_API_KEY='<temporary-admin-api-key>'
feedback-redmine inspect \
  --manifest /secure/feedback-redmine/installation.json \
  --generated-dir /secure/feedback-redmine/generated \
  --output /secure/feedback-redmine/inspection.json
unset FEEDBACK_REDMINE_INSPECT_API_KEY
```

inspectは`/users/current.json`、project、tracker、status、priority、custom field、role、user、membershipをGETするだけで、Redmineを変更しない。
管理用endpointを読むため、一時的なadministrator API keyを使用し、integration API keyとは分離する。不足または不一致があれば終了code 2となり、
profileを生成しない。custom fieldのproject/tracker/role割当とworkflowの最終確認はRESTだけでは不足するため、Rails側planまたは管理画面でも確認する。

同名fieldのID競合は、目的が同じで形式・filter・対象project/tracker/roleが完全一致する場合だけ再利用する。それ以外は既存fieldを変更せず、
Redmine管理者と別名称または専用projectを決めてmanifestとprofileを再作成する。server profileへ推測したIDや別環境のIDをコピーしない。

### 3.4 role、user、status、workflow

integration userは専用の通常userとし、administratorにしない。他projectのmemberにも追加しない。roleのissue visibilityは「すべてのチケット」、
権限は次だけにする。

- チケットの閲覧（`view_issues`）
- チケットの追加（`add_issues`）
- チケットの編集（`edit_issues`）
- 注記の追加（`add_issue_notes`）
- 非公開注記の閲覧（`view_private_notes`）
- private issueを使う場合だけチケットを非公開に設定（`set_issues_private`）

open statusとclosed statusを各1つ決め、trackerの既定statusをopenへ設定する。integration roleのworkflowには
open→open、open→closed、closed→open、closed→closedの4遷移を設定する。Feedback UIは担当、優先度、状態を変更しないが、
Redmine側の管理操作とdescription自己編集がworkflowで予期せず拒否されないことを確認する。

作成後、integration userのAPI keyを一度だけ取得してsecret managerへ保存する。server profileの`secretRef`はsecretの論理名だけを持ち、
API keyそのものをprofile、SPA、runtime config、image、Gitへ書かない。

## 4. SPA、gateway、reverse proxyの設定

### 4.1 配備時runtime config

SPAは`/.well-known/feedback-redmine.json`を`Cache-Control: no-store`、`Content-Type: application/json`で同一originから配信する。

```json
{
  "schemaVersion": "1",
  "enabled": true,
  "profileId": "inventory-production",
  "gatewayBasePath": "/internal/feedback-redmine/v1"
}
```

このファイルは公開情報だけで、Redmine URL、数値ID、API key、participant署名鍵を含めない。配備時に`enabled`を変更できるため、
Feedbackの有効・無効だけならSPAを再buildせず、runtime configの配備と次回ページロードで切り替えられる。不正な設定、取得失敗、unknown fieldはfail-closedでUIをmountしない。

```ts
import { useEffect } from "react";
import { createRedmineFeedbackPluginControllerFromRuntimeConfig } from "@feedback/redmine-plugin/loader";
import type { RedmineFeedbackPluginController } from "@feedback/redmine-plugin/loader";

export function FeedbackIntegration(): null {
  useEffect(() => {
    const abort = new AbortController();
    let feedback: RedmineFeedbackPluginController | null = null;
    void createRedmineFeedbackPluginControllerFromRuntimeConfig({
      adapter,
      contextMenu: true,
      targetResolver,
      pinPositionProvider,
      signal: abort.signal,
      onUnavailable: (error) => console.error("Feedbackを利用できません", error)
    }).then((created) => {
      if (abort.signal.aborted) created?.destroy();
      else feedback = created;
    });
    return () => {
      abort.abort();
      feedback?.destroy();
    };
  }, []);
  return null;
}
```

取得は既定5秒でtimeoutする。React cleanupで`signal`を中止し、StrictMode、route遷移、microfrontend破棄後の遅延mountを防ぐ。
origin rootへ配置できない場合は`configPath: "/inventory/.well-known/feedback-redmine.json"`のように同一originの
root-relative pathを指定する。SSR frameworkではこのcomponentをclient-only境界へ置く。

既存consumerの`VITE_FEEDBACK_REDMINE_ENABLED`はViteのbuild時置換であり、値を変えるだけでは配備済みSPAへ反映されない。
次回upgradeで上記runtime loaderへ移行する。package versionやintegration codeを変更した場合は従来どおりSPAの再buildが必要である。

### 4.2 標準gateway

releaseに含まれる`feedback-redmine-gateway` OCI imageへ次を設定する。

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `FEEDBACK_PUBLIC_ORIGIN` | 必須 | 利用者が開くSPAの正確なorigin。例: `https://inventory.example.test` |
| `FEEDBACK_REDMINE_GATEWAY_PROFILE_FILE` | 必須 | read-onlyの`server-profile.json` absolute path |
| `FEEDBACK_REDMINE_GATEWAY_API_KEY`または`_FILE` | どちらか必須secret | 専用integration userのAPI keyまたはsecret fileのabsolute path |
| `FEEDBACK_PARTICIPANT_SIGNING_KEY` | 必須secret | 32 bytes以上のランダム値 |
| `PORT` | 任意 | listen port。既定8080 |

本番で`NODE_ENV=development`を設定しない。本番profileのRedmine URLと`FEEDBACK_PUBLIC_ORIGIN`はHTTPSを必須とする。
gatewayはHost headerやrequest Originから公開originを推測せず、`FEEDBACK_PUBLIC_ORIGIN`との完全一致で検証する。

起動順は次のとおりである。

1. Redmine DBと添付ファイルvolumeを復元または起動する。
2. Redmineを起動し、REST APIと専用projectを確認する。
3. profileとsecretをread-only mountしてgatewayを起動する。
4. `/internal/feedback-redmine/v1/health/ready`が200になった後にreverse proxyへ組み込む。
5. runtime configとSPAを配備し、`doctor`を実行する。

gateway containerはnon-root、read-only root filesystem、`cap_drop: ALL`、`no-new-privileges`、容量制限付き`/tmp`で動かす。
`health/live`と`health/ready`はprocessと起動時設定のhealthであり、Redmineまでの疎通は`doctor`で確認する。

### 4.3 reverse proxy

[`deploy/feedback-redmine/nginx-location.conf.example`](../deploy/feedback-redmine/nginx-location.conf.example)を、TLSを終端する業務SPAの
server blockへ組み込む。gatewayの8080をインターネットや利用者networkへ直接公開しない。

- `/internal/feedback-redmine/v1/`だけをgatewayへproxyする。
- `Origin`と`Sec-Fetch-*`を削除・書換えしない。
- request body、cookie、API key、participant credentialをaccess/error logへ記録しない。
- screenshot上限を考慮して`client_max_body_size`をprofile上限より少し大きくする。
- CSPの`img-src`で`'self' data: blob:`を許可する。外部scriptは許可しない。
- 外部認証を使う場合はSPAとgateway pathの双方へ同じ認証境界を適用する。

## 5. セキュリティ境界

通信経路は利用者→TLS reverse proxy→SPA/gateway、gateway→TLS Redmineだけにする。Redmineを利用者へ公開する必要はなく、
firewallまたはNetworkPolicyでgatewayからRedmine HTTPSへの接続だけを許可する。gatewayはstatelessなのでDB、volume、object storageへ接続させない。

gatewayのOrigin/Fetch Metadata検証はCSRF緩和であり認証ではない。公開範囲を制限する配備では、OIDC-aware proxy、VPN、mTLS等の
既存アクセス制御を外側へ置く。proxyが認証headerを付けても、現在の公開participant modeはその値を本文やRedmineの本人確認情報として使わない。
`submittedByName`は自己申告表示名である。

secretの扱いは次に固定する。

- Redmine API keyとparticipant署名鍵に既定値を設けない。
- orchestratorのsecret、read-only secret file、またはsecret managerから注入する。
- SPA、HTML、runtime config、client/server profile、container image、Git、log、metric、problem responseへ埋め込まない。
- API keyは専用integration userだけに紐付け、退職者等の個人keyを使わない。
- API keyを更新するときはRedmine側で旧keyを失効して新keyをsecret managerへ登録し、gatewayをrolling restartしてから旧podが消えたことを確認する。
- participant署名鍵の変更は全browser credentialを失効させ、過去投稿の自己編集確認にも影響する。現在は旧鍵keyringを持たないため、通常更新せず、漏えい時のincident対応として利用者へ影響を告知して変更する。

private issueを使う場合も、Redmineのproject membershipとroleを最小にする。`showRedmineLink=true`は利用者がRedmineへ到達でき、
かつチケット表示が許可される環境だけで有効にする。

## 6. 動作確認

通常の疎通確認はRedmine issueを作らない。

```bash
feedback-redmine doctor \
  --origin https://inventory.example.test \
  --profile inventory-production \
  --output doctor.json
```

このcommandはgateway ready、profile、participant credential発行、integration userによるRedmine current user取得を確認する。
検証用issueを作る場合だけ明示的に`--write-canary`を付ける。作成されたthread IDを出力するので、確認後は組織のルールに従い
Redmineで終了または削除する。

```bash
feedback-redmine doctor \
  --origin https://inventory.example.test \
  --profile inventory-production \
  --write-canary
```

stagingでは次のUX smoke testも行う。

1. launcherから対象選択し、選択箇所のpinと独立composerが表示される。
2. `contextMenu: true`で対象を右クリックし、同じcomposerを開ける。
3. composerと詳細drawerをそれぞれ閉じ、再度開ける。
4. 投稿時のpreviewとRedmine attachmentにscreenshotがあり、feedback箇所のpinが画像へ焼き込まれている。
5. 詳細drawerでattachment画像を表示・downloadできる。
6. `他の人の投稿を見る`で同じProfileのWorkspace投稿が表示され、別画面の項目からHostの`navigate`後にthreadを開ける。
7. Feedback UIから返信と自己編集ができ、Redmine journalへ追記される。
8. Redmineからの返信、担当、優先度、状態変更が次回pollでUIへ反映される。
9. runtime configを`enabled:false`にしてページをreloadするとUIをmountせず、`true`へ戻してreloadすると再mountする。

Profileはapplication、environment、external workspaceの組を固定する。`applicationKey`は製品、`environmentKey`は本番／staging等、
`externalWorkspaceKey`は閲覧共有範囲を分ける。`pageKey`は画面、`hostResourceKey`はレコード等の詳細取得境界である。
「他の人の投稿を見る」は同じProfileのWorkspace全体を対象にするため、見せてはいけない集団は別Profileにする。

issue descriptionへ保存するのは初回コメントと、`feedbackThread` queryを持つsame-origin URLだけである。Application、Environment、
Workspace、Page、Host resourceをdescriptionへ重複記載しない。一方、これらのcustom fieldは一覧のscope、API検索、冪等性、resource境界に使う
構造化索引なので、遷移用URLだけでは代替しない。URLを押すとSPAのadapterが対象画面へ遷移し、該当threadを開く。

screenshot取得は現在有効で、ローカルProfileも`capture.enabled=true`である。失敗時は画像なしで投稿できるが、CSP、cross-origin image、
WebGL canvas、upload上限を調べる。MapLibre固有の地物解決と地図pinは自動ではなく、`@feedback/maplibre`のtarget resolverと
pin position providerをHost Adapterへ指定した場合だけ有効になる。

## 7. upgradeとrollback

releaseはnpm tarball、linux/amd64・linux/arm64のgateway/demo OCI archive、CycloneDX SBOM、HIGH/CRITICAL vulnerability report、
release manifest、SHA-256を同じversionで生成する。修正版があるHIGH/CRITICALは生成を停止し、修正版がない項目もSARIFでreviewする。

```bash
bash scripts/build-feedback-redmine-release.sh \
  --output /secure/release/feedback-redmine-<version> \
  --version <version>
```

本番更新は次の順で行う。

1. release manifest、checksum、署名、SBOM、脆弱性reportを検証する。
2. Redmine DBと`files`の同時点backupを取得し、直近のrestore試験結果を確認する。
3. 新versionに同梱されたinstallation schemaとprovisionerを`plan`で実行する。競合があれば停止する。
4. stagingで新gateway、SPA package、runtime configを同じversionへ揃え、read-only doctor、write canary、UX smokeを通す。
5. 本番gatewayを先にrolling updateし、readyとread-only doctorを確認する。
6. package更新がある場合は新SPAを配備する。runtime configだけの切替なら再buildしない。
7. write canaryと主要UXを確認し、監視期間後に旧imageを保持期限まで保管する。

rollbackは、runtime configを`enabled:false`にして新規操作を止め、旧gateway imageと旧SPA artifactを同時versionへ戻す。
provisionerは既存fieldを削除せず、rollbackでもRedmine issue、journal、attachment、custom fieldを削除しない。Redmine設定や保存形式に
非互換変更が含まれるreleaseでは、そのrelease固有の互換性文書とrestore rehearsalがない限り本番へ進めない。

alpha間では公開契約が変わる可能性がある。OpenAPI、JSON Schema、生成型、`docs/api-compatibility.md`、各CHANGELOGを同じreleaseで確認する。

## 8. backup、restore、トラブルシューティング

### 8.1 本番backup

RedmineはDBだけでも`files`だけでも完全に復元できない。次を同じ停止窓または整合性のあるstorage snapshot時点で取得する。

1. reverse proxyでFeedbackのwriteを停止し、gatewayを停止する。
2. Redmine web、job、plugin等の書込processを停止する。DB serviceは起動したままにする。
3. PostgreSQLなら`pg_dump -Fc`等、利用DBの正式な論理backupまたは整合snapshotを取得する。
4. Redmineの`files` directoryまたは対応volumeを同じ時点でarchive/snapshotする。
5. Redmine version、DB engine/version、plugin一覧、設定、取得日時、両artifactのSHA-256をmanifestへ記録する。
6. Redmine、gateway、proxyを再開し、read-only doctorを実行する。

DBのPITRを使う場合は、`files` snapshotとの対応時刻を記録する。backupは暗号化し、API key等のsecret backupとは保管権限を分離する。

restoreは隔離環境で定期的にrehearsalする。対象Redmineとgatewayを停止し、空DBへrestoreして`files`を同じ世代から戻す。
Redmine migrationを対象versionの正式手順で適用した後、添付ファイルの取得、thread一覧、返信、自己編集を確認する。本番restore時も
異なる世代のDBと`files`を混ぜず、復元前の破損状態を別backupとして保全する。

### 8.2 ローカルbackupとrestore

ローカルCLIはRedmine、gateway、demoを停止してからDBとfilesを保存し、checksum付きmanifestと復元に必要なローカルsecret/profileを
0600で保存して再起動する。

```bash
feedback-redmine local backup --output /secure/backups/feedback-local-20260820
feedback-redmine local restore --input /secure/backups/feedback-local-20260820 --yes
```

backup directoryにはsecretが含まれるため、0700相当の親directoryで暗号化保管する。restoreは専用Compose volumeを作り直す破壊的操作である。

### 8.3 障害調査

| 症状 | 確認事項 |
| --- | --- |
| runtime config取得失敗 | path、200、`application/json`、`no-store`、schemaVersion、unknown field、same-origin |
| `origin_not_allowed`相当 | `FEEDBACK_PUBLIC_ORIGIN`とbrowserのscheme/host/port完全一致、proxyがOriginを保持しているか |
| GETだけ拒否 | browserの`Sec-Fetch-Site: same-origin`、proxy／WAFによるheader削除 |
| participant発行失敗 | 署名鍵が32 bytes以上、全podで同一、secretの改行や誤mount |
| Redmine 401 | integration userのAPI key失効、別user key、secretRefと注入名の不一致 |
| Redmine 403 | project membership、最小権限role、private issue、workflow |
| profileを生成できない | inspect JSONのmissing/mismatch、11 fieldの名称・形式・実ID、project/tracker/role割当 |
| 投稿一覧が空 | profile/application/environment/workspace/page/resourceの不一致、別Profileを見ていないか |
| 「他の人の投稿を見る」が不足 | 同じProfileか、workspace scope requestか、Host Adapterのnavigateが完了しているか |
| screenshotがない | `capture.enabled`、CSP `img-src data: blob:`、cross-origin画像、canvas、upload size |
| 地図上のpin/地物がずれる | MapLibre resolver/providerの接続、feature key、map移動後のposition再計算 |
| 詳細画像だけ出ない | Redmine attachment、content type/size、gateway attachment path、Redmine base path |
| restore後に自己編集できない | participant署名鍵を同じ世代から復元したか。localStorage削除や鍵変更後は回復不可 |

調査は`local status`、`local logs`、gateway health、`inspect`、read-only `doctor`の順に行い、write canaryは最後に明示実行する。
access logやsupport bundleへcookie、API key、participant credential、request body、screenshotを含めない。API key更新後は旧keyの失効、
全gateway instanceの再起動、doctorまでを一つの変更作業として記録する。
