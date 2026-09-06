# Changelog

## 未リリース - 2026-09-06

- 未検証v1 journalからv2 messageへの上書きを禁止し、reply／revisionの正規化と署名hashを統一した。既知の初期本文をhashで束縛し、hashのないprovider本文を本人へ昇格しない。現行Redmine v1単独版は変更しない。

## 1.0.0-rc.1 - 2026-09-02

- DBレスのRedmine production Connector、REST transport、provider provisioning planを追加した。
- v1-only reader、stable ID復元、署名済みEnvelope／projection／message／attachment mapperを追加した。
- first-write seed、Envelope、projectionの段階別回復と、v1/v2 dual-writeを追加した。
- attachment binaryを自動再送せず、結果不明を`repair_required`へ閉じるようにした。
- Phase 2 compatibility matrixのRedmine対象fixtureを実装した。
- Envelope／projection段階補修の全provider I/Oへrequest abort signalを伝播した。
- 不正なprojection custom fieldからlegacy projectionへfallbackしないようにした。
- attachment markerの署名済み`messageId`だけで会話へ関連付け、upload前に対象messageの存在を検証するようにした。
- 既存v1 fieldを変更せず、digest確認後にv2専用3 fieldだけを作成するRails runnerを追加した。

## 1.0.0-alpha.7 - 2026-08-31

- Phase 1のConnector entry pointを追加した。
- Phase 2でRedmine 5.1／6.0／6.1／7.0のfirst-write tripletとprocess再起動後回収をconformance化し、共通TCK fixtureを追加した。
