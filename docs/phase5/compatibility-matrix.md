# Phase 5 v1／v2 compatibility matrix

確認日: 2026-09-01

Phase 2で固定した10行を、provider production fixture、Redmine実container conformance、v1 characterization、controller fault testへ対応付けた。unit fakeだけで完結する判断と、provider実環境で確認する判断を分け、後者はRedmine 5.1.12／6.0.10／6.1.3／7.0.0 containerまたは管理Jira Cloud開発siteで実行する。

| matrix行 | provider／環境 | 実行証跡 | 合格条件 |
| --- | --- | --- | --- |
| v1-only ticket | Redmine production fixture＋4 version conformance | `feedback-connector-redmine`の「v1-only ticketをstable IDで再構築」／`check-feedback-redmine-conformance.sh` | v1 read継続、v2 stable ID写像 |
| v2 dual-write ticketのread | Redmine production fixture | 「reply/revisionをv1 markerと署名v2 markerの一writeへdual-write」 | v2 marker優先、legacy-only event保持 |
| v1からdual-write ticketへreply／revision | Redmine production fixture | 「dual-write ticketへv1 gatewayが追加したlegacy-only eventをmerge」 | 既存v2 eventを消さない |
| v2からdual-write ticketへreply／revision | Redmine production fixture＋v1 core | dual-write roundtrip／`normalize.test.ts` | v1 readerがUUIDv7／v2 markerを欠落させない |
| ticket作成後、Envelope前に失敗 | Redmine／Jira Connector fault fixture、Jira Cloud live | create response喪失試験／live `firstWriteTripletRecovered` | provider write再発行0、不足metadataだけ補修 |
| Envelope後、projection前に失敗 | Redmine production fixture、Jira property direct reread | 「Envelope後projection前の失敗」／Jira projection試験 | 同じticketを補修、新ticket 0 |
| projection後、attachment前に失敗 | Redmine／Jira Connector＋controller | attachment timeout試験／controller `repair_required`試験 | binary upload自動再送0、manual confirmation |
| legacyとvalid v2が共存 | Redmine production fixture | 「legacyとvalid v2の差異」 | v2優先、warning、legacy上書きなし |
| legacyとinvalid v2が共存 | Redmine production fixture＋production verifier | invalid Envelope／unknown `kid`試験 | v2 integrity error、legacy／別mode fallbackなし |
| v2停止／rollback | standalone v1 characterization＋v1 core | v1 profile／list／detail／post／reply／revision／attachment、dual-write UUID試験 | v2 storage migrationなしでv1 read／write継続 |

Jira Cloud live acceptanceはrun-owned issue一件に限定し、issue first write、完全一致property検索、comment、append-only revision、attachmentのmessage bindingを含むupload／downloadを通した後、そのissueだけを削除する。Forge development installationは保持する。live evidenceへsite URL、project／issue ID、account、credentialを保存しない。

`@geibee/feedback-provider-acceptance`はrenderer共通suiteに加え、production `FeedbackHttpClient` → Feedback Service → Gateway → projection verifier → Jira Connectorをin-process transportで通す。public participant credential発行、結果不明create、明示intent回収、署名済み本文readを実装classの経路で確認し、Jira native createが一回だけであることを固定する。

ReactとWeb Componentは`@geibee/feedback-provider-acceptance`の同一snapshot／command suiteをJira Cloud／Redmine行へ適用する。provider HTTPやstorageをrendererへ混入させず、Connector TCKとproduction composition testを別層で通す。
