# Changelog

## Unreleased

- frozen v2 OpenAPIを`FeedbackClientPort`へ写像するgeneric HTTP／fetch transportを実装した。
- wire problemの型付きmapping、multipart uploadの一回消費、attachment download streamingを追加した。
- intent回収のrequest hashをOpenAPIどおり必須headerへ写像し、request-scoped credential provider、Bearer／participant credentialの排他検証、POST CSRF headerを追加した。
- `public-profile`用participant credential発行methodを追加し、新規browserからwrite credentialをbootstrapできるようにした。

## 1.0.0-alpha.7 - 2026-08-31

- Phase 1のcontract-only `FeedbackClientPort` skeletonを追加した。
- Phase 2でprofile／workspace／resource discovery scope、thread付きintent回収、operation別result、stream sourceを固定し、recording fake clientを追加した。
