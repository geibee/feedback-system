# @feedback/redmine-gateway

顧客の業務アプリケーション認証middleware後段へ組み込む、Web標準`Request`/`Response`ベースのstateless handlerです。
DB、queue、cache、filesystem upload、object storageを使用しません。

hostはauthentication、profile read/create authorization、resource authorization、stored resource authorization、
CSRF検証、profile/secret loaderを注入します。API keyはserver-side secretからだけ取得し、responseやproblemへ含めません。

実装時は`contracts/feedback/redmine-gateway.openapi.yaml`と次を必須にしてください。

- routeを業務アプリと同一originに置き、CORSを有効化しない。
- integration userをFeedback projectだけの非administrator memberにする。
- access logからcookie、body、query、`X-Redmine-API-Key`を除外する。
- reverse proxyを含めrequest/response sizeとtimeoutを制限する。
- profile/secretに既定値を設けず、未設定時は起動を失敗させる。
