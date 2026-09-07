# Changelog

## 未リリース - 2026-09-07

- 直接参照の対応宣言、request-scoped provider参照と解決通知を実装portへ追加した。

## 1.0.0-rc.1 - 2026-09-02

- `FeedbackConnectorProblem`へ、OpenAPIの404 problem codeと一致する`feedback.not_found`を追加した。
- Redmine／Jira Cloud／Backlogへ同じ`FeedbackRepositoryPort`とoperation recovery結果を適用した。

## 1.0.0-alpha.7 - 2026-08-31

- Phase 1のserver-only `ProviderRef`と`FeedbackRepositoryPort` skeletonを追加した。
- Phase 2でraw candidate read、thread付きintent回収、operation別result、streaming attachment port、Connector TCKとrecording fakeを追加し、契約版を`2-alpha.1`へ進めた。
