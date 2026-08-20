# Feedback Redmine gateway

## 配置境界

gatewayは業務アプリケーションと同一originの`/internal/feedback-redmine/v1`へmountするstateless handlerである。公開契約は
`contracts/feedback/redmine-gateway.openapi.yaml`、実装用packageは`@feedback/redmine-gateway`である。

gatewayはDB、filesystem upload、queue、cache、object storageを使用しない。Redmine API keyはserver-side secretからだけ取得し、
browser、problem response、metric、access logへ返さない。CORS routeを作らず、HTTPS reverse proxy配下へ置く。
POSTは`Origin`完全一致を必須とする。same-origin GETはbrowserが`Origin`を省略するため、`Sec-Fetch-Site: same-origin`を必須とし、
`Origin`が存在する場合だけ完全一致を追加検証する。

## 公開participant mode

標準modeはhost sessionやOIDCに依存しない。`GatewayDependencies`へ次を注入する。

- `participantSigningKey`: 32 bytes以上の秘密鍵。既定値禁止
- `loadProfile`: 公開client profileとRedmine接続profile
- `loadSecret`: Redmine integration API key
- `fetch`: server-side Redmine fetch

`POST /profiles/{profileId}/participants`はbrowserが生成した非公開browser profile UUIDから、署名鍵・origin・profileで別の公開participant UUIDを
不可逆に導出し、originとprofileへscopeしたopaque credentialをHMAC署名して返す。SDKはcredential、非公開UUID、公開UUIDをlocalStorageへ保存し、
書き込み時にcredentialだけを`X-Feedback-Participant-Credential`で送る。会話応答やRedmineへ非公開UUIDを保存しないため、公開participant UUIDを
再登録して自己編集権を取得することはできない。localStorage削除後のidentity recoveryや端末間同期は行わず、新しいUUIDを採番する。
表示名は利用者の自己申告値であり、認証済み氏名ではない。

読み取り、新規投稿、返信は同一origin利用者へ公開する。participant credentialは自己編集の所有確認であり、実在人物の認証やアクセス認可では
ない。Origin/Fetch Metadata headerは通常のHTTP clientでも生成できるため、公開範囲を制限したい配備ではgatewayの外側にアクセス制御を置く。
SDKからOIDC JWT、access token、host cookie内容をgateway bodyへPOSTしない。

## server profile

server profileはRedmine URL、project/tracker/default priority、private flag、終了status ID、11個のcustom field ID、公開client profile、
secret referenceを持つ。clientがこれらを上書きできるrequest fieldはない。Redmine base URLは本番でHTTPSだけを許可し、
userinfo、query、fragment、dot segmentを拒否する。

reference appではprofileを2ファイルへ分ける。client profileにはUIへ公開できる値だけを置き、server profileから
`clientProfileRef`で参照する。API keyをどちらのJSONにも置かない。

```json
{
  "profileId": "inventory-production",
  "clientProfileRef": "client-profile.json",
  "redmineBaseUrl": "https://redmine.example.invalid/redmine",
  "projectId": 12,
  "trackerId": 4,
  "isPrivate": true,
  "defaultPriorityId": 2,
  "closedStatusIds": [5],
  "customFieldIds": {
    "threadId": 21,
    "requestHash": 22,
    "applicationKey": 23,
    "environmentKey": 24,
    "externalWorkspaceKey": 25,
    "pageKey": 26,
    "hostResourceKey": 27,
    "perspectiveCode": 28,
    "locator": 29,
    "submittedById": 30,
    "submittedByName": 31
  },
  "authorizationMode": "resource-scoped",
  "showRedmineLink": false,
  "secretRef": "FEEDBACK_REDMINE_GATEWAY_API_KEY"
}
```

設定する環境変数は[`environment-variables.md`](environment-variables.md)を参照する。reference appの3変数はいずれも
未設定時に起動を失敗し、secretに既定値はない。libraryを本番hostへ組み込む場合は環境変数名を公開契約にせず、既存の
設定・secret注入機構から`loadProfile`、`loadSecret`、`participantSigningKey`を実装する。

## HTTPと冪等性

gatewayはparticipant発行、profile/capability、current participant、thread list/create/detail、message create/update、attachmentの固定operationだけを受け付ける。
unknown query、JSON field、multipart partを拒否する。createは`multipart/form-data`の`request` JSONと任意の`evidence`だけを受け、
`Idempotency-Key`とbodyの`intentId`一致を必須にする。

trusted connectorはcreate前にthread IDを検索する。同じrequest hashのissueがあれば200で回収し、確認済みの新規作成は201を返す。
POST結果が通信断で不明な場合はPOSTをblind retryせず、thread検索だけを行う。hash不一致またはduplicate thread IDは409相当で拒否する。

GETだけ429/5xxを上限付きでretryする。timeout、request/response size、decoded image size、content typeを制限し、redirectを拒否する。
attachment `content_url`はRedmine base URLと同じorigin/base pathだけを許可する。

返信と編集もmutationごとにUUID `Idempotency-Key`を必須とする。返信は終了statusで拒否し、自己編集は終了後も許可する。
edit requestの`expectedVersion`がRedmine journalからfoldした最新版と違う場合は409を返す。message所有markerはcredentialとは別に署名し、
credentialや署名鍵をRedmine、response log、diagnosticへ保存しない。

## reference app

`apps/feedback-redmine-gateway-reference`は公開participant modeのWeb標準handlerをNode HTTP serverへ接続する最小例である。
session cookieや固定principalは使用しない。本番artifactには含めず、secret managerやreverse proxyは配備環境側で用意する。

Docker imageは`node` userで動作し、read-only root filesystem、`--cap-drop ALL`、
`no-new-privileges`で起動できる。reverse proxyのaccess logからcookie、request body、query、
`X-Redmine-API-Key`を除外する。

検証:

```bash
npm --workspace @feedback/redmine-gateway run typecheck
npm --workspace @feedback/redmine-gateway run test
npm --workspace @feedback/redmine-gateway run build
bash scripts/check-feedback-redmine-security.sh
```
