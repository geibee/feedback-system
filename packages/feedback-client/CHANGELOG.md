# Changelog

## 1.0.0-rc.3 - 2026-09-09

- RC.2で判明したOCI imageのbuild時刻依存を除去し、同一commitの再buildで同じdigestを生成する。公開APIと実行時挙動は変更しない。

## 1.0.0-rc.2 - 2026-09-08

- RC.1 release集合のstale build混入を解消するclean rebuild。公開APIと実行時挙動は変更しない。

## 未リリース - 2026-09-07

- 暗号化threadReferenceのopt-inと個別操作header伝播を追加し、command hash・URLへ含めない。

## 1.0.0-rc.1 - 2026-09-02

- frozen v2 OpenAPIを`FeedbackClientPort`へ写像するgeneric HTTP／fetch transportを実装した。
- wire problemの型付きmapping、multipart uploadの一回消費、attachment download streamingを追加した。
- intent回収のrequest hashをOpenAPIどおり必須headerへ写像し、request-scoped credential provider、Bearer／participant credentialの排他検証、POST CSRF headerを追加した。
- `public-profile`用participant credential発行methodを追加し、新規browserからwrite credentialをbootstrapできるようにした。

## 1.0.0-alpha.7 - 2026-08-31

- Phase 1のcontract-only `FeedbackClientPort` skeletonを追加した。
- Phase 2でprofile／workspace／resource discovery scope、thread付きintent回収、operation別result、stream sourceを固定し、recording fake clientを追加した。
