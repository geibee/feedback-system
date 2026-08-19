# Changelog

## Unreleased

- 初回投稿からextension由来の`submissionChannel` metadataを除去し、host session経路へ一本化しました。
- request JSONとevidenceを含む2-part multipartを正しく読み取れるようにしました。

## 1.0.0-alpha.1

- 固定operation handler、host auth/authz/CSRF SPI、stream multipart上限、Redmine trusted connectorを追加。
- 新規createを201、同一intent/request hashの冪等回収を200で返すOpenAPI準拠判定を追加。
