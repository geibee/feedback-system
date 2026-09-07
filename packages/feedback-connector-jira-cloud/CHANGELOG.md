# Changelog

## 未リリース - 2026-09-07

- 署名Envelopeに束縛した直接issue参照へ対応し、参照付き操作ではJQL検索へfallbackしない。

## 未リリース - 2026-09-06

- 既知の初期本文を署名hashへ束縛し、旧Envelopeの未検証本文を本人へ帰属させない。ADFの空行とinline textを保持し、旧初期messageの署名済みrevisionを安全に再構築する。

## 1.0.0-rc.1 - 2026-09-02

- Jira Cloud REST API v3のissue、comment、property、attachment clientを実装した。
- JQL projection検索、direct property再読込、intent回収、paginationを実装した。
- provider error正規化とbinary自動再送0のstreaming uploadを追加した。
- entity property indexだけを持つForge artifactをpackage配下へ移した。
- projection改ざんのfail-closed検査、response size上限、安全なdownload redirect、cursor／pagination境界を追加した。
- Jira componentをfrozen authorization契約の`record` resourceへ正規化した。
- comment本文hash、append-only revision chain、最新revision detailを検証するようにした。
- attachmentのmessage関連付けとdownload content SHA-256検証を追加した。
- comment propertyの直接再読込をREST v3の正規endpointへ修正した。
- Jira固有のattachment datetime offsetを署名契約のUTC ISO形式へ正規化し、upload後のmapping失敗をmanual confirmationへ閉じた。
- attachment metadataのint64 IDとupload responseの文字列IDを同じserver-only文字列へ正規化した。
- attachment upload前に対象messageの存在を検証し、未知messageIdではnative binaryを書き込まないようにした。

## 1.0.0-alpha.7 - 2026-08-31

- Phase 1のJira Cloud Connector entry pointを追加した。
- Phase 2でJira Cloud REST v3のlive contract spike結果と共通TCK fixtureを追加し、create／replyをrecoverable、revision／attachmentをbest-effortへ固定した。
