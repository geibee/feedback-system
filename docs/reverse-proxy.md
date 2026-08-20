# Feedback Redmine reverse proxy

本番のFeedback gatewayは業務SPAと同じHTTPS originの`/internal/feedback-redmine/v1/`へ配置する。gatewayのlisten portは
利用者networkへ公開せず、reverse proxyからだけ到達可能にする。実行可能なNginx location例は
[`deploy/feedback-redmine/nginx-location.conf.example`](../deploy/feedback-redmine/nginx-location.conf.example)にある。

必須条件は次のとおりである。

- SPA、`/.well-known/feedback-redmine.json`、gateway pathを同じscheme、host、portで公開する。
- TLS 1.2以上を組織標準のcertificateとcipher policyで終端し、HTTPはHTTPSへredirectする。
- gatewayへ`Origin`と`Sec-Fetch-*`をそのまま転送する。
- request body、cookie、`X-Redmine-API-Key`、`X-Feedback-Participant-Credential`をlogへ出さない。
- `client_max_body_size`をclient profileの`capture.maximumUploadBytes`より少し大きくする。
- upstream timeoutは通常操作を有限時間で失敗させる。無制限timeoutやredirect追従を設定しない。
- runtime configは`application/json`かつ`Cache-Control: no-store`で返す。
- CSPの`img-src`へ`'self' data: blob:`を許可し、screenshot previewを阻害しない。

公開participant modeのOrigin検証は外部認証を置き換えない。利用者を限定する場合は、SPAのHTML／assetとgateway pathの双方へ
同じOIDC-aware proxy、VPN、mTLS等を適用する。gateway pathだけ認証を外す構成や、認証後の別originからCORSで呼ぶ構成はサポートしない。

load balancerのhealth probeは`/internal/feedback-redmine/v1/health/ready`を使う。これはgateway processと起動時設定のreadyを表し、
Redmine REST、profile、participant credentialまでの疎通は配備後に`feedback-redmine doctor`で確認する。

network boundary、secret、起動順、doctorの完全な手順は
[`feedback-redmine-installation.md`](feedback-redmine-installation.md)を参照する。
