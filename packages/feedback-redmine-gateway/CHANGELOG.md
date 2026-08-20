# Changelog

## Unreleased

- 初回投稿からextension由来の`submissionChannel` metadataを除去しました。
- request JSONとevidenceを含む2-part multipartを正しく読み取れるようにしました。
- 公開participant credential発行、message create/update、署名済み所有marker検証を追加しました。
- 旧host auth/authz/CSRF SPIを削除し、公開participant modeへ一本化しました。
- resource scopeを後方互換で維持しつつ、Profileを閲覧境界とするWorkspace一覧と総件数を追加しました。
- createの任意`threadUrl`を同一origin・対象threadへ制限し、初回自己編集署名をcontext attachmentから検証するようにしました。
- `custom` targetのprovider、fallback座標、scalar metadataを投稿境界でfail-closed検証するようにしました。

## 1.0.0-alpha.1

- 固定operation handler、host auth/authz/CSRF SPI、stream multipart上限、Redmine trusted connectorを追加。
- 新規createを201、同一intent/request hashの冪等回収を200で返すOpenAPI準拠判定を追加。
