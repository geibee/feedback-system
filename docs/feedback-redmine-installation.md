# Feedback Redmine導入・利用ガイド

この文書は、FeedbackをRedmineへ導入する担当者と、導入後にFeedbackを利用する人のための手順書です。
目的に合う節だけを上から順に実施してください。

| やりたいこと | 読む節 |
| --- | --- |
| 手元で動かしてみる | [1. ローカルで試す](#1-ローカルで試す) |
| 既存Redmineへ導入する | [2. 登録先を決める](#2-feedbackの登録先を決める)、[3. 既存Redmineの準備](#3-既存redmineの準備) |
| SPAとgatewayを配備する | [4. SPAとgatewayを配備する](#4-spaとgatewayを配備する) |
| 特定チケットの子チケットとして起票する | [6.2 特定チケットの子チケットとして起票する](#62-特定チケットの子チケットとして起票する) |
| 更新または切り戻す | [8. 更新と切戻し](#8-更新と切戻し) |
| エラーを調べる | [10. 困ったとき](#10-困ったとき) |

## 1. ローカルで試す

必要なものはNode.js 22.12以上25未満、npm、Docker Engine、Docker Compose v2です。

リポジトリのルートで次を実行します。

```bash
npm ci
npm run feedback:redmine:local
```

起動したら、ブラウザで次を開きます。

- Feedbackデモ: `http://127.0.0.1:4173`
- Redmine: `http://127.0.0.1:3001`

Redmineのログイン情報は次のコマンドで確認します。

```bash
node packages/feedback-redmine-ops/dist/cli.js local credentials
```

Feedbackデモで「フィードバック」を押し、画面上の対象を選び、投稿者名とコメントを入力して送信します。その後Redmineへログインし、
Feedbackチケットと添付画像が作成されていれば確認完了です。

終了するときは次を実行します。データは次回起動時にも残ります。

```bash
node packages/feedback-redmine-ops/dist/cli.js local down
```

データも削除する場合だけ次を実行します。このコマンドはローカル評価環境専用です。

```bash
node packages/feedback-redmine-ops/dist/cli.js local reset --yes
```

## 2. Feedbackの登録先を決める

導入前に、FeedbackをどのRedmineプロジェクトへ登録するか決めます。

| 要件 | 登録先 |
| --- | --- |
| Feedbackを業務チケットから分けたい | 新しいFeedback専用プロジェクト |
| 既存の業務チケットの子チケットとしてFeedbackを起票したい | 親チケットと同じ既存プロジェクト |

親チケットはFeedbackの登録先と同じプロジェクトにあるものだけ指定できます。例えば業務プロジェクトのチケット`#123`の子として起票したい場合は、
Feedbackの登録先もその業務プロジェクトにします。Feedback専用プロジェクトから別プロジェクトの`#123`を親にすることはできません。

特に理由がなければFeedback専用プロジェクトを推奨します。既存プロジェクトを使う場合は、既存のtrackerやroleを変更せず、Feedback専用の
tracker、role、integration userを追加します。

## 3. 既存Redmineの準備

導入前に次を確認します。

- Redmine 5.1.12、6.0.10、6.1.3、7.0.0のいずれかを利用している。
- RedmineのREST APIを有効にできる。
- Redmineの管理者と、Rails runnerまたは管理画面を利用できる。
- gatewayからRedmineのHTTPS URLへ接続できる。
- RedmineのDBと`files`を同じ時点へ復元できる。

Redmine自体を新規構築する場合は、先にRedmine公式手順と組織の標準手順でRedmine、DB、`files`、TLS、mail、backupを用意します。
このリポジトリのローカル評価用Composeを本番へ流用しないでください。

### 3.1 設定ファイルを作る

サンプルをコピーします。

```bash
install -d -m 700 /secure/feedback-redmine
cp docs/examples/feedback-redmine-installation.json \
  /secure/feedback-redmine/installation.json

# 実際に導入するversionへ置き換える
export FEEDBACK_REDMINE_VERSION='1.0.0-alpha.6'
```

`installation.json`を開き、少なくとも次を実環境に合わせます。

| 項目 | 入力する値 |
| --- | --- |
| `redmineBaseUrl` | gatewayから接続するRedmineのHTTPS URL |
| `project.identifier`、`project.name` | 新しく作る専用プロジェクト、または利用する既存プロジェクト |
| `profileId` | 環境を識別する名前。例: `inventory-production` |
| `applicationKey` | 対象アプリケーション。例: `inventory` |
| `environmentKey` | `production`、`staging`など |
| `externalWorkspaceKey` | Feedbackを相互に閲覧できる範囲 |
| `isPrivate` | Redmine上で非公開チケットにする場合は`true` |
| `captureEnabled` | スクリーンショットを添付する場合は`true` |
| `showRedmineLink` | 利用者にRedmineへのリンクを見せる場合は`true` |

API key、password、署名鍵、Redmineの数値IDはこのファイルへ書きません。

### 3.2 新しいFeedback専用プロジェクトを自動作成する

この手順は、Rails runnerを実行できる場合に使用します。既存の業務プロジェクトには実行しないでください。

provisionerを取り出します。

```bash
npx "@geibee/feedback-redmine-ops@${FEEDBACK_REDMINE_VERSION}" provision extract \
  --output /secure/feedback-redmine/provision.rb
```

以降の`npx`コマンドでも同じ`FEEDBACK_REDMINE_VERSION`を使用します。

`provision.rb`と`installation.json`をRedmineサーバーへ配置し、まず変更予定だけを出力します。

```bash
RAILS_ENV=production bundle exec rails runner \
  /secure/feedback-redmine/provision.rb plan \
  /secure/feedback-redmine/installation.json \
  /secure/feedback-redmine/output
```

`output/provision-plan.json`を開きます。`conflicts`が空であり、`operations`が意図した内容なら、同じファイルの`planDigest`を指定して適用します。

```bash
FEEDBACK_REDMINE_PLAN_DIGEST="$(
  jq -r '.planDigest' /secure/feedback-redmine/output/provision-plan.json
)"
RAILS_ENV=production bundle exec rails runner \
  /secure/feedback-redmine/provision.rb apply \
  /secure/feedback-redmine/installation.json \
  /secure/feedback-redmine/output \
  "${FEEDBACK_REDMINE_PLAN_DIGEST}"
```

`conflicts`が1件でもある場合は適用せず、既存設定と重ならない名称へ`installation.json`を直して、`plan`からやり直します。

適用後は`output`に配備用ファイルができます。

| ファイル | 配置先 |
| --- | --- |
| `client-profile.json`、`server-profile.json` | gatewayのread-only設定volume |
| `runtime-config.json` | SPAの`/.well-known/feedback-redmine.json` |
| `redmine-api-key` | secret manager。登録後は作業ディレクトリから削除 |

### 3.3 既存の業務プロジェクトへ手動で追加する

既存の業務プロジェクトにはprovisionerを実行しません。Redmine管理画面で次を追加します。

1. Feedback専用trackerを作り、対象プロジェクトで有効にする。
2. Feedback専用の通常ユーザーを作る。管理者にはしない。
3. Feedback専用roleを作り、対象プロジェクトでintegration userへ割り当てる。
4. open用とclosed用のstatusを決め、Feedback trackerのworkflowを設定する。
5. [付録A](#付録a-手動で作成するredmine設定)の11個のカスタムフィールドを作る。
6. integration userのAPI keyを発行し、secret managerへ保存する。

既存プロジェクトの名前、公開範囲、module、既存tracker、既存role、既存workflowは変更しません。

設定後、管理者API keyを一時的に環境変数へ入れて検査します。

```bash
export FEEDBACK_REDMINE_INSPECT_API_KEY='<temporary-admin-api-key>'
npx "@geibee/feedback-redmine-ops@${FEEDBACK_REDMINE_VERSION}" inspect \
  --manifest /secure/feedback-redmine/installation.json \
  --manual-checklist /secure/feedback-redmine/manual-checklist.md \
  --output /secure/feedback-redmine/inspection.json
unset FEEDBACK_REDMINE_INSPECT_API_KEY
```

初回の終了code 2は、管理画面でしか確認できない項目が未承認であることを表します。`inspection.json`に`missing`または`mismatch`があれば、
先にRedmineの設定を直します。次に`manual-checklist.md`を管理画面と照合し、問題がなければ`inspection.json`の`manualCheckDigest`を指定します。

```bash
FEEDBACK_REDMINE_MANUAL_DIGEST="$(
  jq -r '.manualCheckDigest' /secure/feedback-redmine/inspection.json
)"
export FEEDBACK_REDMINE_INSPECT_API_KEY='<temporary-admin-api-key>'
npx "@geibee/feedback-redmine-ops@${FEEDBACK_REDMINE_VERSION}" inspect \
  --manifest /secure/feedback-redmine/installation.json \
  --accept-manual-checks "${FEEDBACK_REDMINE_MANUAL_DIGEST}" \
  --generated-dir /secure/feedback-redmine/generated \
  --output /secure/feedback-redmine/inspection-accepted.json
unset FEEDBACK_REDMINE_INSPECT_API_KEY
```

終了code 0になり、`generated`に`client-profile.json`、`server-profile.json`、`runtime-config.json`が作成されれば準備完了です。

## 4. SPAとgatewayを配備する

具体的なCompose、Nginx、Reactの例は[SPA導入ガイド](spa-integration-guide.md)を使用します。ここでは配備時に必要な操作だけを示します。

### 4.1 gatewayを配備する

GitHub Release一式を展開したディレクトリで、`release-manifest.json`に記載されたdigestのimageを取得します。

```bash
FEEDBACK_REDMINE_GATEWAY_DIGEST="$(
  jq -r '.images[] | select(.name == "feedback-redmine-gateway") | .indexDigest' \
    release-manifest.json
)"
docker pull "ghcr.io/geibee/feedback-redmine-gateway@${FEEDBACK_REDMINE_GATEWAY_DIGEST}"
```

gatewayへ次を設定します。

| 変数 | 値 |
| --- | --- |
| `FEEDBACK_PUBLIC_ORIGIN` | 利用者が開くSPAのorigin。例: `https://inventory.example.com` |
| `FEEDBACK_REDMINE_GATEWAY_PROFILE_FILE` | `server-profile.json`のcontainer内absolute path |
| `FEEDBACK_REDMINE_GATEWAY_API_KEY_FILE` | Redmine API keyのsecret file |
| `FEEDBACK_PARTICIPANT_SIGNING_KEY` | 32 bytes以上のランダムなsecret |
| `FEEDBACK_REDMINE_OPTIONAL_ISSUE_FIELDS` | 親チケット、期限、重要度を使う場合だけ[6.2](#62-特定チケットの子チケットとして起票する)の値を設定 |

`server-profile.json`と同じread-onlyディレクトリへ`client-profile.json`も置きます。gatewayの8080番portは外部へ公開せず、SPAと同じoriginの
`/internal/feedback-redmine/v1/`へreverse proxyします。

起動後、ready endpointを確認します。

```bash
curl --fail --silent --show-error \
  https://inventory.example.com/internal/feedback-redmine/v1/health/ready
```

### 4.2 SPAへ追加する

packageを追加します。

```bash
npm install "@geibee/feedback-redmine-plugin@${FEEDBACK_REDMINE_VERSION}"
```

[SPA導入ガイドの組込み例](spa-integration-guide.md#spaへ導入する)に従ってHost Adapterとplugin controllerを追加します。

生成された`runtime-config.json`を、SPAと同じoriginの`/.well-known/feedback-redmine.json`として配備します。このファイルにはsecretを
追加しません。緊急時は`enabled`を`false`に変更して再配備し、利用者がページを再読み込みするとFeedback UIを停止できます。

## 5. 導入結果を確認する

まず、チケットを作らない疎通確認を実行します。

```bash
npx "@geibee/feedback-redmine-ops@${FEEDBACK_REDMINE_VERSION}" doctor \
  --origin https://inventory.example.com \
  --profile inventory-production
```

次にstagingのSPAで1件投稿し、次を確認します。

1. 「フィードバック」から画面上の対象を選べる。
2. 投稿前にスクリーンショットが表示される。
3. 送信後、Redmineにチケットと画像が作成される。
4. SPAから返信するとRedmineの注記へ追加される。
5. Redmineで状態や担当者を変えるとSPAにも反映される。
6. 「他の人の投稿を見る」から同じWorkspaceの投稿を開ける。

CLIで検証用チケットを作る場合は、stagingだけで次を実行します。

```bash
npx "@geibee/feedback-redmine-ops@${FEEDBACK_REDMINE_VERSION}" doctor \
  --origin https://inventory.example.com \
  --profile inventory-production \
  --write-canary
```

## 6. 利用者の操作

### 6.1 通常のFeedbackを起票する

1. 対象画面で「フィードバック」を押す。
2. Feedbackを付けたい場所を選ぶ。右クリックが有効な画面では、対象を右クリックしても開ける。
3. レビュー観点、投稿者名、コメントを入力する。
4. スクリーンショットの内容を確認して「送信」を押す。

既存の投稿を読む場合は「他の人の投稿を見る」を押します。投稿を選ぶと、返信、添付画像、Redmineで変更された状態・担当者・重要度を確認できます。

### 6.2 特定チケットの子チケットとして起票する

最初に管理者が一度だけ設定します。

1. Feedbackの登録先が、親にしたいチケットと同じRedmineプロジェクトであることを確認する。
2. Redmine管理画面でFeedback用roleを開き、「サブタスクの管理」権限を有効にする。
3. gatewayへ次を設定し、gatewayを再作成する。

```text
FEEDBACK_REDMINE_OPTIONAL_ISSUE_FIELDS=parent_issue
```

期限と重要度も利用者に選ばせる場合は、代わりに次を設定します。

```text
FEEDBACK_REDMINE_OPTIONAL_ISSUE_FIELDS=parent_issue,due_date,priority
```

Docker Composeの場合の反映例です。

```bash
docker compose up -d --force-recreate feedback-redmine-gateway
```

SPAを再読み込みし、投稿画面に「親チケットID」が表示されれば管理者の設定は完了です。

利用者は次のように起票します。

1. Redmineで親にしたいチケットを開き、URLまたは見出しからチケット番号を確認する。`/issues/123`なら番号は`123`。
2. SPAで「フィードバック」を押して対象を選ぶ。
3. 投稿画面の「親チケットID」に`123`と入力する。
4. コメント等を入力して「送信」を押す。
5. Redmineで新しいFeedbackチケットを開き、親チケットが`#123`になっていることを確認する。

「親チケットを指定できません」と表示された場合は、親チケットが別プロジェクトにないか、削除・非公開になっていないか、integration userが
閲覧できるか、「サブタスクの管理」権限が付いているかを確認します。

## 7. 管理者の日常操作

- Feedbackへの回答は、通常のRedmineチケットと同じように注記を追加する。次回の自動更新でSPAにも表示される。
- 完了にする場合はRedmineでclosed statusへ変更する。再開時はopen statusへ戻す。
- 担当者、重要度、件名、説明、添付ファイルの変更はSPAの「Redmineの変更履歴」で確認できる。
- Feedback UIを一時停止する場合は`/.well-known/feedback-redmine.json`の`enabled`を`false`にして再配備する。
- 動画等を別の保管先へ置いてほしい場合は、runtime configの`submissionNotice`に案内文とHTTPSリンクを設定する。

## 8. 更新と切戻し

### 8.1 更新する

1. release一式を同じディレクトリへ取得し、SHA-256を確認する。

   ```bash
   cd "/secure/release/feedback-redmine-${FEEDBACK_REDMINE_VERSION}"
   sha256sum --check SHA256SUMS
   ```

2. 組織のRedmine backup手順でDBと`files`を同じ時点にbackupする。
3. リリースノートにRedmine設定変更が記載されている場合だけ、[3.2](#32-新しいfeedback専用プロジェクトを自動作成する)の`plan`を実行する。
4. stagingへ新しいgateway image、SPA package、runtime configを配備する。
5. stagingで[5節](#5-導入結果を確認する)の2つのコマンドと画面操作を行う。
6. 本番gatewayのimage digestを更新し、[4.1](#41-gatewayを配備する)のready確認と[5節](#5-導入結果を確認する)の最初のコマンドを実行する。
7. SPA packageを変更したreleaseではSPAもbuild・配備する。runtime configだけの変更ではSPAをbuildし直さない。
8. 本番で[6.1](#61-通常のfeedbackを起票する)の操作を1回行う。

### 8.2 切り戻す

1. `/.well-known/feedback-redmine.json`の`enabled`を`false`にして再配備する。
2. gatewayを直前のimage digestへ戻す。
3. SPAを直前のartifactへ戻す。gatewayとSPAは同じrelease versionへ揃える。
4. [4.1](#41-gatewayを配備する)のready確認と[5節](#5-導入結果を確認する)の最初のコマンドを実行する。
5. runtime configの`enabled`を`true`へ戻して再配備し、1件起票する。

切戻し時にRedmineのチケット、注記、添付ファイル、カスタムフィールドを削除しません。release固有のDBまたはRedmine設定変更がある場合は、
そのリリースノートに記載された手順を優先します。

## 9. バックアップと復元

Feedback用に別のDBやobject storageはありません。既存のRedmine運用と同じ手順で、次の2つを必ず同じ時点へbackupします。

- Redmine DB
- Redmineの`files`ディレクトリまたはvolume

復元試験では、隔離環境へ同じ世代のDBと`files`を戻し、Feedback一覧、返信、添付画像を確認します。DBだけ、または`files`だけを戻さないでください。

ローカル評価環境だけはCLIでbackup、restoreできます。

```bash
node packages/feedback-redmine-ops/dist/cli.js local backup \
  --output /secure/backups/feedback-local-20260822

node packages/feedback-redmine-ops/dist/cli.js local restore \
  --input /secure/backups/feedback-local-20260822 \
  --yes
```

## 10. 困ったとき

| 症状 | 最初に行うこと |
| --- | --- |
| Feedbackボタンが出ない | `/.well-known/feedback-redmine.json`が200、JSON、`enabled:true`になっているか確認する |
| readyが失敗する | gateway logでprofile file、API key file、署名鍵の設定を確認する |
| Redmine 401 | integration userのAPI keyを再発行し、gatewayのsecretを更新する |
| Redmine 403 | integration userが対象プロジェクトのmemberか、Feedback用roleを持つか確認する |
| 親チケットを指定できない | 親とFeedbackが同じプロジェクトか、「サブタスクの管理」権限があるか確認する |
| 投稿一覧が空 | 本番／stagingやWorkspaceが異なる別Profileを開いていないか確認する |
| スクリーンショットがない | `captureEnabled`、CSP、cross-origin画像、upload上限を確認する |
| Redmineへのリンクが出ない | `showRedmineLink`が`true`か、利用者がRedmineを閲覧できるか確認する |

次の順で状態を確認します。

```bash
node packages/feedback-redmine-ops/dist/cli.js local status
node packages/feedback-redmine-ops/dist/cli.js local logs
npx "@geibee/feedback-redmine-ops@${FEEDBACK_REDMINE_VERSION}" doctor \
  --origin https://inventory.example.com \
  --profile inventory-production
```

本番では最初の2つのローカル用コマンドは実行せず、gatewayのlogとread-only doctorを確認します。logや問い合わせ資料へAPI key、cookie、
participant credential、投稿本文、スクリーンショットを含めないでください。

## 付録A: 手動で作成するRedmine設定

### Feedback用role

issue visibilityを「すべてのチケット」にし、次の権限だけを付けます。

- チケットの閲覧
- チケットの追加
- チケットの編集
- 注記の追加
- 非公開注記の閲覧
- `isPrivate:true`の場合は、チケットを非公開に設定

まずこの権限構成で[3.3のinspect](#33-既存の業務プロジェクトへ手動で追加する)を完了します。親チケットを指定する場合は、その後に
[6.2](#62-特定チケットの子チケットとして起票する)の手順で「サブタスクの管理」を追加します。

open statusとclosed statusの間は、open→open、open→closed、closed→open、closed→closedの4遷移を許可します。

### Feedback用カスタムフィールド

すべて「チケット」のカスタムフィールドとして作り、対象プロジェクト、Feedback tracker、Feedback roleだけに割り当てます。
「全プロジェクト向け」は無効にします。

| 名称 | 形式 | フィルタと検索 |
| --- | --- | --- |
| Feedback Thread ID | テキスト（1行） | 有効 |
| Feedback Request Hash | テキスト（1行） | 無効 |
| Feedback Application | テキスト（1行） | 有効 |
| Feedback Environment | テキスト（1行） | 有効 |
| Feedback Workspace | テキスト（1行） | 有効 |
| Feedback Page | テキスト（1行） | 有効 |
| Feedback Host Resource | テキスト（1行） | 有効 |
| Feedback Perspective | テキスト（1行） | 有効 |
| Feedback Locator | 長いテキスト | 無効 |
| Feedback Submitted By ID | テキスト（1行） | 無効 |
| Feedback Submitted By Name | テキスト（1行） | 無効 |

## 付録B: 配備時の注意

- Redmine API keyとparticipant署名鍵をSPA、runtime config、profile、image、Git、logへ書かない。
- gatewayの8080番portを利用者へ直接公開しない。
- SPAとgateway pathには同じ認証・アクセス制御を適用する。
- `showRedmineLink:true`は、利用者がRedmineの対象チケットを閲覧できる場合だけ使用する。
- API keyには個人のものではなく、対象プロジェクトだけに所属するintegration userのものを使用する。
