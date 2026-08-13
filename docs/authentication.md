# 認証

Feedback Serviceは、Feedback audienceを持つBearer JWTの直接OIDC検証と、契約済みtoken exchange JWT検証を
独立したtrust boundaryとして正式にサポートする。配備時は少なくとも一方を設定し、両方を併用する場合はissuerを
分離する。tokenの未検証issuerはverifier選択だけに使い、一致したtrust boundaryで署名・issuer・audience・有効期限を
完全検証する。direct検証失敗後にexchange検証へfallbackするfirst-success方式は採用しない。

直接OIDCは `FEEDBACK_OIDC_ISSUER` と `FEEDBACK_OIDC_AUDIENCE` を設定した場合だけ有効になる。
異なる認証基盤ではホストbackendが自身のHttpOnly sessionを検証し、mTLSでreference brokerの
`POST /v1/exchanges` を呼ぶ。Service側は `FEEDBACK_TOKEN_EXCHANGE_*` だけでも起動できる。
ブラウザ由来のuser/role headerをactorとして信用しない。

brokerはmTLS identityごとのtenant/application/environment/workspace/permission上限を適用し、300秒以内のJWTを発行する。
claimは `actor_issuer`、`actor_sub`、`feedback_tenant`、`feedback_application`、`feedback_environment`、
`feedback_workspace`、`feedback_permissions`。Serviceの実効権限はDB membershipとの積集合である。

exchange-only配備では、brokerの停止またはJWKS取得失敗時に直接OIDCへ迂回せず認証を拒否する。direct-only配備でも
exchange issuerのtokenは拒否する。認証境界をどちらも設定しない構成、片方の必須変数だけを欠く部分設定、両境界で
同一issuerを使う構成は起動時にfail-closedで拒否する。

契約は `contracts/feedback/token-exchange.openapi.yaml` と `schemas/token-exchange-jwt.schema.json` を正本とする。
