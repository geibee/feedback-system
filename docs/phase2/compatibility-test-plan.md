# v1／v2 compatibility matrix test計画

記録日: 2026-08-31

Phase 2ではreader／dual-write本実装を開始しない。次の10行をPhase 3 Redmine laneとPhase 5統合で実行する受け入れfixtureとして固定し、未実装を成功扱いしない。

| matrix行 | fixture／操作 | 期待値 | 実行Phase |
| --- | --- | --- | --- |
| v1-only ticket | 現行Redmine conformance issueをv2 readerへ入力 | v1は現行どおり、v2はstable IDを維持してlegacy写像 | Phase 3 Redmine |
| v2 dual-write ticketのread | 同一eventをv1／v2 markerで保存しlegacy-only eventを追加 | v1はlegacy、v2はv2優先かつlegacy-onlyをstable ID merge | Phase 3 Redmine |
| v1からdual-write ticketへreply／revision | v2 Envelope後にv1 gatewayからreplyと自己編集 | v2 readerがlegacy-only eventを保持し既存v2 eventを消さない | Phase 3 Redmine |
| v2からdual-write ticketへreply／revision | 同じintentでlegacy markerと署名v2 markerを追加 | v1はlegacyを読み、v2は対応付けて一件へ重複排除 | Phase 3 Redmine |
| ticket作成後、Envelope前に失敗 | first-write recovery seedだけのticket | v1 read可能、v2は同じticketへEnvelope／projectionだけを補修 | Phase 3 Redmine／Jira |
| Envelope後、projection前に失敗 | valid Envelope、検索projectionなし | object IDから読め、projectionだけを補修。新ticket 0 | Phase 3 provider lanes |
| projection後、attachment前に失敗 | valid Envelope／projection、attachmentなし | read可能、uploadは自動再送せずpending／repair_required | Phase 3 controller／provider lanes |
| legacyとvalid v2が共存 | metadata値が一部異なるdual fixture | v2優先、差異warning、legacy値で上書きしない | Phase 3 Redmine |
| legacyとinvalid v2が共存 | 署名改ざんEnvelopeとvalid legacy | v1 standaloneのみ継続、v2 integrity error、fallbackなし | Phase 3 gateway／Redmine |
| v2停止／rollback | v2 facade停止後にstandalone v1を実行 | v1 read／write継続、v2形式migrationを要求しない | Phase 5 |

全行でprofile、workspace、resource、Authorization Modeを固定し、別mode、別provider、host DBへのfallbackがないことも検査する。
