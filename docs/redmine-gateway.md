# Feedback Redmine gateway

## 配置境界

gatewayは業務アプリケーションの既存認証middleware後段、同一originの
`/internal/feedback-redmine/v1`へmountするstateless handlerである。公開契約は
`contracts/feedback/redmine-gateway.openapi.yaml`、実装用packageは`@feedback/redmine-gateway`である。

gatewayはDB、filesystem upload、queue、cache、object storageを使用しない。Redmine API keyはserver-side secretからだけ取得し、
browser、problem response、metric、access logへ返さない。CORS routeを作らず、HTTPS reverse proxy配下へ置く。
POSTは`Origin`完全一致を必須とする。same-origin GETはbrowserが`Origin`を省略するため、`Sec-Fetch-Site: same-origin`を必須とし、
`Origin`が存在する場合だけ完全一致を追加検証する。

## host SPI

`FeedbackRedmineGatewayHost`として次を業務アプリ側が実装する。

- `authenticate`: 既存sessionからstable opaque subject、任意の表示名、任意のRedmine user IDを返す
- `authorizeProfile`: profileごとのread/createを認可する
- `authorizeResource`: list/create対象のclient resource refを検証し、保存用opaque resource keyを返す
- `authorizeStoredResource`: detail/attachmentごとに保存済みresource keyを再認可する
- `verifyCsrf`: `X-Feedback-CSRF`を既存CSRF機構で検証する

authentication/profile authorizationが失敗したrequestではprofile secretを読み込まず、Redmine fetchを一度も行わない。
detailとattachmentではthread UUIDを固定profile scopeで検索した後、保存済みresource keyを再認可する。attachment IDはthreadへの
membershipを確認してからmetadata/contentを取得する。

## server profile

server profileはRedmine URL、project/tracker/default priority、private flag、12個のcustom field ID、公開client profile、
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
    "submittedByName": 31,
    "submissionChannel": 32
  },
  "authorizationMode": "resource-scoped",
  "showRedmineLink": false,
  "secretRef": "FEEDBACK_REDMINE_GATEWAY_API_KEY"
}
```

設定する環境変数は[`environment-variables.md`](environment-variables.md)を参照する。3変数はいずれも未設定時に起動を失敗し、
secretに既定値はない。

## HTTPと冪等性

gatewayはprofile/capability、current principal、thread list、create、detail、attachmentの固定operationだけを受け付ける。
unknown query、JSON field、multipart partを拒否する。createは`multipart/form-data`の`request` JSONと任意の`evidence`だけを受け、
`Idempotency-Key`とbodyの`intentId`一致を必須にする。

trusted connectorはcreate前にthread IDを検索する。同じrequest hashのissueがあれば200で回収し、確認済みの新規作成は201を返す。
POST結果が通信断で不明な場合はPOSTをblind retryせず、thread検索だけを行う。hash不一致またはduplicate thread IDは409相当で拒否する。

GETだけ429/5xxを上限付きでretryする。timeout、request/response size、decoded image size、content typeを制限し、redirectを拒否する。
attachment `content_url`はRedmine base URLと同じorigin/base pathだけを許可する。

## reference app

`apps/feedback-redmine-gateway-reference`はWeb標準handlerをNode HTTP serverへ接続する最小例である。CLI起動時のdemo adapterは
署名付きcookieを要求し、未署名cookieや固定principalを受理しない。ただし業務resourceを実認可するproduction adapterではないため、
本番では必ず顧客実装へ差し替える。

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
