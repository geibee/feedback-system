# @feedback/redmine-gateway

業務アプリケーションと同一originへ組み込む、Web標準`Request`/`Response`ベースのstateless handlerです。
DB、queue、cache、filesystem upload、object storageを使用しません。

標準の公開participant modeでは32 bytes以上の`participantSigningKey`とprofile/secret loaderを注入します。API keyと署名鍵は
server-side secretからだけ取得し、responseやproblemへ含めません。participant credentialはbrowser profile単位の自己編集所有確認であり、
実在人物の認証ではありません。

実装時は`contracts/feedback/redmine-gateway.openapi.yaml`と次を必須にしてください。

- routeを業務アプリと同一originに置き、CORSを有効化しない。
- integration userをFeedback projectだけの非administrator memberにする。
- access logからcookie、body、query、`X-Redmine-API-Key`を除外する。
- reverse proxyを含めrequest/response sizeとtimeoutを制限する。
- profile/secretに既定値を設けず、未設定時は起動を失敗させる。
