# 環境変数

新規導入では「Redmine gateway」だけを参照してください。SPAは環境変数を読まず、`/.well-known/feedback-redmine.json`を読みます。

secretには既定値がありません。secret managerまたはorchestratorのsecret機能から注入し、Git、image、公開runtime config、logへ保存しないでください。

## Feedback Service v2

Phase 5の`@geibee/feedback-service-runtime`は次の非secret設定を読み、`feedback-service-settings.v2`、`feedback-provider-profile.v2`、Connector runtime catalogを起動前に検証します。Feedback Service本体はprovider非依存のまま、別deploy compositionがnetwork listenerとConnectorを接続します。

| 変数 | 必須 | 指定する値 |
| --- | --- | --- |
| `FEEDBACK_SERVICE_SETTINGS_FILE` | 必須 | `feedback-service-settings.v2` JSONのcontainer内absolute path |
| `FEEDBACK_CONNECTOR_PROFILES_FILE` | 必須 | read-only Connector runtime catalog JSONのcontainer内absolute path |
| `FEEDBACK_PUBLIC_ORIGIN` | 必須 | Feedbackを利用するSPAのoriginだけ。path、query、credentialは不可 |
| `FEEDBACK_SERVICE_BASE_PATH` | 任意 | v2 API base path。既定は`/internal/feedback/v2` |
| `FEEDBACK_MAXIMUM_REQUEST_BYTES` | 任意 | request body上限。既定は`8388608`、範囲は1024〜1073741824 bytes |
| `FEEDBACK_OPERATION_TIMEOUT_MILLISECONDS` | 任意 | providerを含む一操作のhard deadline。既定は`30000`、範囲は100〜60000 ms |
| `FEEDBACK_SERVICE_HOST` | 任意 | listen host。既定はloopbackの`127.0.0.1` |
| `FEEDBACK_SERVICE_PORT` | 任意 | listen port。既定は`8080` |

settingsは不変な`serviceId`、read-only provider profile file一覧、signed grant issuer allowlist、remote authorization profile、上限付きJWKS cache設定だけを持ちます。profileやsettingsへcredential、HMAC key、tokenを埋め込まず、`{ "kind": "server-secret", "id": "..." }`でserver-side secretを参照します。

fixtureで使用する次のIDはsecret値ではなく、secret manager／orchestrator側の名前です。実配備ではprofileが参照するIDと注入名を一致させ、値に既定値を設けません。

```text
FEEDBACK_JIRA_CLOUD_CREDENTIAL
FEEDBACK_BACKLOG_CREDENTIAL
FEEDBACK_ENVELOPE_KEY_RING
FEEDBACK_PARTICIPANT_CREDENTIAL_KEY_RING
FEEDBACK_PARTICIPANT_ID_DERIVATION_KEY
```

`FEEDBACK_ENVELOPE_KEY_RING`と`FEEDBACK_PARTICIPANT_CREDENTIAL_KEY_RING`は別の32 bytes以上のkey materialを持つring、`FEEDBACK_PARTICIPANT_ID_DERIVATION_KEY`はさらに独立した32 bytes以上のkeyです。provider profileの`maximumMetadataBytes`と`creationFields`はread-only設定であり、環境変数ではありません。

key ring secretは次のexact JSONとする。`activeKid`は新規署名に一つだけ使用し、`keys`内の他の鍵は検証専用として扱う。`key`は32 bytes以上のcanonical base64urlで、値に既定値はない。

```json
{
  "activeKid": "2026-09",
  "keys": [
    { "kid": "2026-09", "key": "BASE64URL_SECRET" },
    { "kid": "2026-06", "key": "OLD_BASE64URL_SECRET" }
  ]
}
```

provider credential secretはConnectorごとに次のexact JSONとする。Jira CloudはAtlassian account emailとAPI token、RedmineとBacklogは専用integration userのAPI keyを使う。Forge CLI tokenはJira Connector credentialとして再利用しない。

```json
{ "kind": "jira-cloud-basic", "email": "service-account@example.com", "apiToken": "SECRET" }
```

```json
{ "kind": "redmine-api-key", "apiKey": "SECRET" }
```

```json
{ "kind": "backlog-api-key", "apiKey": "SECRET" }
```

`/readyz`はprovider credentialのexact JSON、Envelope／participant credential key ringのactive一鍵・最大8鍵・32 bytes以上のcanonical base64url、participant ID導出鍵を実際にparseする。Backlog profileではさらにproject、`feedback.threadId`、`feedback.intentId`、`feedback.requestHash`、`feedback.resourceKey`の4 Text custom field、issue type、priorityをprovider APIで確認する。不正、不足、provisioning driftでは`ready: false`とHTTP 503を返す。secret値やparse errorの入力値はresponseへ含めない。

`public-profile` browserのparticipant credentialは環境変数では配布しない。同一originの発行APIへ端末内browser profile UUIDを渡して取得し、browser側で当該profileのwrite requestだけへ付与する。

Connector runtime catalogはsecretを持たず、provider profileの`connectorProfileRef`から一意に参照する。Jira entryは`siteUrl`、`application`、`environment`、`issueTypeId`、attachment上限、content type、timeout、page size、回収待ちを持つ。Redmine entryはこれらに相当する値とworkspace／project／tracker／v2 custom field IDを持つ。Backlog entryはHTTPS origin、単一workspace／project、issue type、priority、4 Text custom field ID、metadata上限、timeout、page size、回収待ちを持つ。Backlog attachmentは非対応なので`maximumAttachmentBytes=1`、`attachmentContentTypes=[]`へ固定する。schema、実装、運用例のdriftは検証scriptで検査する。

### Backlog Stage A managed acceptance専用

次はBacklog SaaS Stage Aのrun-owned検証だけに一時設定する。credentialをrepo file、fixture、logへ保存しない。

| 変数 | 必須 | 指定する値 |
| --- | --- | --- |
| `BACKLOG_STAGE_A_BASE_URL` | 必須 | 許可済みBacklog SaaS spaceのHTTPS origin |
| `BACKLOG_STAGE_A_API_KEY` | 必須 | test利用者のAPI key。transportは`Backlog-API-Key` headerへ変換する |
| `BACKLOG_STAGE_A_PROJECT_KEY` | 必須 | cleanup可能な専用project key |
| `BACKLOG_STAGE_A_CLEANUP_POLICY` | 必須 | `delete-run-owned`固定 |

`scripts/run-feedback-backlog-stage-a.mjs`はrun固有issue、comment、attachmentだけを作成し、fault境界と別process再構築を確認後にすべて削除する。`BACKLOG_STAGE_A_RECONSTRUCT_INPUT`と`BACKLOG_STAGE_A_SIGNING_SECRET`はrunnerが別processへ一時注入する内部値であり、利用者が設定または永続化しない。

### Backlog Stage B live Conformance専用

次は実Backlog Connectorのrun-owned受け入れ試験だけに一時設定する。通常のFeedback Service processへ渡さず、credentialをrepo file、fixture、logへ保存しない。

| 変数 | 必須 | 指定する値 |
| --- | --- | --- |
| `FEEDBACK_BACKLOG_ACCEPTANCE_BASE_URL` | 必須 | 許可済みBacklog SaaS spaceのHTTPS origin |
| `FEEDBACK_BACKLOG_ACCEPTANCE_API_KEY` | 必須 | test利用者のAPI key。URL queryへ含めず`Backlog-API-Key` headerだけへ変換する |
| `FEEDBACK_BACKLOG_ACCEPTANCE_PROJECT_KEY` | 必須 | 4 Text custom fieldをprovisionし、cleanup可能な専用project key |
| `FEEDBACK_BACKLOG_ACCEPTANCE_CLEANUP_POLICY` | 必須 | `delete-run-owned`固定 |

`bash scripts/check-feedback-backlog-live.sh`は実Connectorでcreate、reply、append-only revisionのcommit後応答喪失、thread／resource検索、別process再構築、unsupported operation、cleanupを検証する。`FEEDBACK_BACKLOG_RECONSTRUCT_INPUT`と`FEEDBACK_BACKLOG_SIGNING_SECRET`はrunnerが別processへ一時注入する内部値であり、利用者が設定または永続化しない。

standalone listenerへ`remote-authorization` profileを設定する場合、任意headerではなく認証済みsubjectを返すhost adapterをcode compositionで注入する。adapterなしでは起動に失敗する。subject用header名や共有secretに暗黙の既定値はない。

### Jira Cloud managed acceptance専用

次はPhase 5の管理された開発site受け入れ試験だけに一時設定する。通常のFeedback Service processへ渡さない。credentialはshellまたはFIFOから注入し、repo file、fixture、logへ保存しない。

| 変数 | 必須 | 指定する値 |
| --- | --- | --- |
| `FEEDBACK_JIRA_ACCEPTANCE_SITE_URL` | 必須 | 許可済みJira Cloud開発siteのHTTPS origin |
| `FEEDBACK_JIRA_ACCEPTANCE_PROJECT_KEY` | 必須 | 許可済みtest project key |
| `FEEDBACK_JIRA_ACCEPTANCE_EMAIL` | FIFO未指定時 | test利用者のAtlassian account email |
| `FEEDBACK_JIRA_ACCEPTANCE_API_TOKEN` | FIFO未指定時 | test利用者の一時API token |
| `FEEDBACK_JIRA_ACCEPTANCE_CREDENTIAL_FIFO` | credential環境変数未指定時 | 上記emailとAPI tokenを各1行で一度だけ渡すFIFO。指定時は2つのcredential環境変数より優先する |
| `FEEDBACK_JIRA_ACCEPTANCE_CLEANUP_POLICY` | 必須 | `delete-run-owned`固定 |
| `FEEDBACK_JIRA_ACCEPTANCE_ISSUE_TYPE_ID` | 任意 | 未指定時はcreate metadataから非subtaskのTaskまたは先頭候補を選ぶ |

受け入れscriptはrun ID付きissueを一件だけ作成し、comment、revision、attachment、property検索を検証後、そのissueだけを削除する。既存issue、project、Forge installationは削除しない。FIFOは読み取り後に閉じるが削除しないため、呼出元が専用一時directoryとFIFOを削除する。

Phase 2 Jira contract spikeのForge／Jira credentialは利用者のWSL shellへ一時注入して使用し、repo file、fixture、Feedback Service設定へ保存していません。Phase 3でも新しい固定secret環境変数名は追加しておらず、profileのsecret reference IDと同名の環境変数だけをdeploy環境で必須解決します。Forge CLIのlogin情報をFeedback Serviceのsecret名として再利用しません。

Jira Connector配下の`forge-app`はentity property index専用の独立deploy artifactです。Forge CLIの認証／environmentはそのdeploy操作だけに使用し、Feedback Service processへ環境変数やForge runtime bindingを追加しません。

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
