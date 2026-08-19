# Changelog

## 1.0.0-alpha.1

- 本番導入前のgateway専用化としてauthor sourceを`host-session`へ限定し、投稿経路識別用の
  `submissionChannel` custom fieldとdescription metadataを削除。
- 共通Redmine port、thread model、profile検証、context/hash、DTO正規化、cursor、trusted REST clientを追加。
- strict response/client-state validator、primary evidence再構築、invalid API key写像、createの新規/回収判定を追加。
- secretや業務本文を型上保持しない最大100件のmemory diagnostic ring bufferを追加。
- draft/pending intentをprincipal scopeで分離し、pendingのprepared/uncertain状態と7日失効を追加。
