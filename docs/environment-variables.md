# 環境変数

新規導入では「Redmine gateway」だけを参照してください。SPAは環境変数を読まず、`/.well-known/feedback-redmine.json`を読みます。

secretには既定値がありません。secret managerまたはorchestratorのsecret機能から注入し、Git、image、公開runtime config、logへ保存しないでください。

## Redmine gateway

標準配布gatewayで使用する設定です。

| 変数 | 必須 | 指定する値 |
| --- | --- | --- |
| `FEEDBACK_PUBLIC_ORIGIN` | 必須 | 利用者が開くSPAのorigin。例: `https://app.example.com` |
| `FEEDBACK_REDMINE_GATEWAY_PROFILE_FILE` | どちらか | `server-profile.json`のcontainer内absolute path |
| `FEEDBACK_REDMINE_GATEWAY_PROFILE_JSON` | どちらか | `clientProfile`を埋め込んだ最大64 KiBのserver profile JSON |
| `FEEDBACK_REDMINE_GATEWAY_API_KEY` | どちらか | Feedback専用integration userのRedmine API key |
| `FEEDBACK_REDMINE_GATEWAY_API_KEY_FILE` | どちらか | API keyを保存したsecret fileのabsolute path |
| `FEEDBACK_PARTICIPANT_SIGNING_KEY` | 必須 | 32 bytes以上のランダムな署名鍵 |
| `FEEDBACK_REDMINE_OPTIONAL_ISSUE_FIELDS` | 任意 | 下表の値をcomma区切りで指定 |
| `PORT` | 任意 | listen port。既定は`8080` |

profileは`_FILE`か`_JSON`の一方、API keyは値か`_FILE`の一方だけを指定します。両方指定するとgatewayは起動しません。本番で`NODE_ENV=development`を設定しないでください。

任意の起票項目は次の値だけを指定できます。

| 値 | 投稿画面へ出す項目 | Redmine側の追加条件 |
| --- | --- | --- |
| `parent_issue` | 親チケットID | integration roleへ「サブタスクの管理」を付与 |
| `due_date` | 期限 | なし |
| `priority` | 重要度 | Redmineで有効なpriorityがあること |

例:

```text
FEEDBACK_REDMINE_OPTIONAL_ISSUE_FIELDS=parent_issue,due_date,priority
```

署名鍵を変更すると、既存browserのparticipant credentialが無効になります。通常の更新では値を維持してください。

## Redmine運用CLI

| 変数 | 使用箇所 |
| --- | --- |
| `FEEDBACK_REDMINE_INSPECT_API_KEY` | 既存Redmineを`inspect`するときだけ使う一時管理者API key |
| `FEEDBACK_REDMINE_RELEASE_BUILDER` | release builderの一時Docker Buildx builder名 |

`inspect`では`--api-key-env`を指定すると、管理者API keyを別名の環境変数から読めます。終了後はunsetしてください。

`local up`はstate directoryの`.env`へ次を自動生成します。利用者が本番へ設定する値ではありません。

```text
FEEDBACK_REDMINE_COMPOSE_PROJECT
FEEDBACK_REDMINE_STATE_DIR
FEEDBACK_REDMINE_OPS_ASSETS
FEEDBACK_REDMINE_HOST_UID
FEEDBACK_REDMINE_HOST_GID
FEEDBACK_REDMINE_DB_PASSWORD
FEEDBACK_REDMINE_SECRET_KEY_BASE
FEEDBACK_PARTICIPANT_SIGNING_KEY
FEEDBACK_REDMINE_ADMIN_PORT
FEEDBACK_REDMINE_DEMO_PORT
FEEDBACK_REDMINE_GATEWAY_IMAGE
FEEDBACK_REDMINE_DEMO_IMAGE
FEEDBACK_REDMINE_OPTIONAL_ISSUE_FIELDS
```

state directoryにはpassword、API key、署名鍵があるため0700で保護します。

次はRedmineのbuild／適合性試験専用です。本番へ設定しません。

```text
FEEDBACK_REDMINE_IMAGE
FEEDBACK_REDMINE_CONFORMANCE_SECRET
FEEDBACK_REDMINE_CONFORMANCE_RUN_ID
FEEDBACK_RELEASE_VERSION
FEEDBACK_RELEASE_BUILDER
```

検証scriptが重複処理を避けるため、子scriptへ次を内部設定します。利用者が
`bash scripts/verify-feedback.sh`を実行するときは設定しません。

```text
FEEDBACK_VERIFY_SKIP_NPM_CI
FEEDBACK_VERIFY_SKIP_COMMON_CONTRACTS
```
