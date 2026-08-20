# 認証

> **Legacy Feedback Service:** この文書はPostgreSQL版Feedback ServiceのOIDC/token exchange向けです。
> Redmine正本SPAの公開participant modeはOIDC/session認証を使いません。gateway署名credentialは自己編集のbrowser profile所有確認だけに使います。

Feedback Serviceは、Feedback audienceを持つBearer JWTの直接OIDC検証と、契約済みtoken exchange JWT検証を
独立したtrust boundaryとして正式にサポートする。配備時は少なくとも一方を設定し、両方を併用する場合はissuerを
分離する。tokenの未検証issuerはverifier選択だけに使い、一致したtrust boundaryで署名・issuer・audience・有効期限を
完全検証する。direct検証失敗後にexchange検証へfallbackするfirst-success方式は採用しない。

直接OIDCは `FEEDBACK_OIDC_ISSUER` と `FEEDBACK_OIDC_AUDIENCE` を設定した場合だけ有効になる。
直接OIDCのaccess tokenは、検証対象のissuer、audience、時刻、設定済みsubject claimに加え、
`feedback_permissions`を1件以上の文字列配列で必須とする。語彙は `feedback.read`、`feedback.comment`、
`feedback.manage`、`feedback.admin`だけである。claimがない、空、文字列配列でない、未知の値を含むtokenは
401で拒否する。直接OIDCのpermissionはresource座標を制限せず、各resourceのDB membershipと常に交差する。

OAuth scope名とaccess token claimは別物である。IdPにFeedback用OAuth scopeを登録し、例えばAdmin Consoleが要求する
`feedback.admin`を `feedback_permissions: ["feedback.admin"]` へmappingする。scopeを要求しただけでclaimが発行されない
IdP設定では認証できない。Admin Consoleの要求値はtoken上限であり、DB membershipにない権限は許可しない。

異なる認証基盤ではホストbackendが自身のHttpOnly sessionを検証し、mTLSでreference brokerの
`POST /v1/exchanges` を呼ぶ。Service側は `FEEDBACK_TOKEN_EXCHANGE_*` だけでも起動できる。
ブラウザ由来のuser/role headerをactorとして信用しない。

brokerはmTLS identityごとのtenant/application/environment/workspace/permission上限を適用し、300秒以内のJWTを発行する。
claimは `actor_issuer`、`actor_sub`、`feedback_tenant`、`feedback_application`、`feedback_environment`、
`feedback_workspace`、`feedback_permissions`。Serviceの実効権限はDB membershipとの積集合である。

exchange-only配備では、brokerの停止またはJWKS取得失敗時に直接OIDCへ迂回せず認証を拒否する。direct-only配備でも
exchange issuerのtokenは拒否する。認証境界をどちらも設定しない構成、片方の必須変数だけを欠く部分設定、両境界で
同一issuerを使う構成は起動時にfail-closedで拒否する。

直接OIDCのBearer JWT契約は `contracts/feedback/openapi.yaml` の `bearerAuth`、token exchange契約は
`contracts/feedback/token-exchange.openapi.yaml` と `schemas/token-exchange-jwt.schema.json` を正本とする。
