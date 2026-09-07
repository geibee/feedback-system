# Feedback v2 Contract freeze

記録日: 2026-08-31

freeze識別子: `feedback-v2-contract-2.0.0-alpha.1`

この識別子は未commit作業treeに対する契約版であり、git tagを作成したことを意味しない。公開契約の正本は`contracts/feedback`、package内のinterfaceは生成型を利用するimplementation portである。Phase 3以降に破壊的変更を行う場合は、契約ownerの承認、全consumer影響確認、生成型・fixture・互換文書の同時更新を必須とする。

## Release前訂正

2026-09-01の実装監査でalpha.1の公開participant発行経路とattachmentのmessage署名bindingに欠落が判明したため、現行識別子を`feedback-v2-contract-2.0.0-alpha.2`とする。alpha.1はPhase 2時点の履歴として残す。alpha.2ではintent回収hashを既存OpenAPIの必須headerへ実装統一し、public-profile participant発行endpoint、signed grant／participant credential security scheme、unsafe operationの必須CSRF headerを追加し、署名attachment markerへ必須`messageId`を追加した。全consumer影響、生成型、codec、両Connector、互換性文書、保存形式migration、CHANGELOGを同時更新する。

## 2026-09-07の利用者承認による参照拡張

現行識別子を `feedback-v2-contract-2.0.0-alpha.3` とする。[共通参照規約](../../contracts/feedback/thread-reference.md)がalpha.2を拡張する。DBレス・重複排除best-effort、opt-in応答、独立暗号鍵、全consumerの参照伝播を採用し、Redmine v1と認可境界は維持する。alpha.1／alpha.2のGate結果は履歴であり、本拡張のlive成功を意味しない。

## DBレス回復境界

- Feedback ServiceはDB、queue、persistent／shared application data cache、upload directory、private object storage、host DB直接参照を持たない。
- Feedback本文、conversation、revision、attachment、証跡、操作回復metadataはproviderを正本とする。
- createの最初のticket writeで`threadId`、`intentId`、`requestHash`を同時保存する。
- provider object IDが作成前に不明なproviderでは、最初のwriteに未信頼のrecovery seedを保存する。response取得またはseed検索回収後、object IDへ束縛した署名Envelopeで同じpropertyを更新する。
- recovery seedと検索projectionは候補抽出専用である。候補のEnvelope署名、provider binding、request scope、現在のAuthorization Mode decision、profile policy、backend capabilityを検証するまでbrowserへ返さない。
- 検索0件はindex遅延中に`pending`とし、安全な不存在を証明できない限り自動createしない。複数hitは`repair_required`とし、自動選択しない。

## provider別の保証水準

| provider | create | reply | revision | attachment upload |
| --- | --- | --- | --- | --- |
| Redmine 5.1／6.0／6.1／7.0 | `recoverable` | `recoverable` | `best-effort` | `best-effort` |
| Jira Cloud REST v3 | `recoverable` | `recoverable` | `best-effort` | `best-effort` |

- Redmine createは単一issue POSTへtripletを保存し、別processからthread custom field検索と本文markerで回収する。
- Jira createは単一issue POSTのissue propertyへtripletを保存し、Forge entity property indexの完全一致JQLで回収する。
- replyは本文と署名intent markerを同じprovider writeへ保存し、解決済みthread内のevent scanで一意回収できる。
- revisionは履歴を破壊しないappend-only eventとする。ただし両providerともexpected revisionの確認とappendをprovider側の単一atomic条件にできないため`best-effort`とする。競合検出時は409 `feedback.conflict`、結果不明時は自動再appendしない。
- attachmentはnative upload成功response後にstable IDとprovider attachment IDの署名mappingを保存できるが、response喪失時の一意回収を共通保証できない。試行上限1、binary自動再送0、結果不明は`repair_required`である。

## query、command、result、error

- profileはresource scope付き、workspace discoveryはprofile target、resource discoveryはworkspace target、thread操作はresource targetとして認可する。
- create、reply、revision、upload commandはstrict DTOで、全writeにstable result ID、`intentId`、domain-separated `requestHash`を要求する。
- intent回収は`threadId`、`intentId`、`requestHash`、operation、profile、workspace、resourceの完全なscopeを要求する。
- 成功dispositionは`created`、`recovered`、`already_applied`。回復状態は`not_found`、`pending`、`completed`、`repair_required`である。
- `pending`と`repair_required`は`automaticWriteAllowed: false`を必須とする。attachmentでは`manual-confirmation`または`do-not-write`を返す。
- provider unavailableは502、authorization unavailableは503、provider timeoutは504、rate limitは429、sizeは413、media typeは415、conflictは409へ正規化する。
- cursorはquery fingerprintとstable ordering boundaryへ束縛したopaque値で、timestamp同値はstable event IDで順序を確定する。

## Authorization Mode

- profileごとに`public-profile`、`signed-grant`、`remote-authorization`の一つへ固定し、request、path、token、障害を理由にmode fallbackしない。
- authorization targetはprofile、workspace、resourceの3 levelを明示し、上位discoveryの認可に架空resourceを要求しない。
- 有効権限はAuthorization Mode decision、immutable profile policy、backend capabilityの積集合だけである。
- signed grantのissuer、単一audience、必須claim、最大寿命300秒、失効上限330秒、scope完全一致、unknown `kid` fail-closedはADR 0002の値を維持する。
- remote authorizationのtimeout、不正response、認証失敗はfail-closedであり、public profileへfallbackしない。
- attachment uploadは独立した`feedback:attachment:upload`を必須とする。

## Envelopeとcontroller

- Envelope、message marker、attachment mappingはRFC 8785相当のcanonical JSON、用途別domain separator、HS256 key ringで署名する。alpha.2 attachment mappingはthread IDに加えて関連先message IDを必須署名対象にする。
- active signing keyは一つ、旧keyはverify-only、unknown `kid`はfail-closedとする。participant credential鍵とparticipant ID導出鍵を分離する。
- message markerはreply／revision、logical message ID、event ID、expected revision、participant ID、body hashを署名対象にする。
- controller pending intentは完全なscope、thread ID、stable result IDを保持する。capture cancel後の結果をcommitせず、`repair_required` attachmentを自動uploadしない。
- follow、draft、unreadはbrowser local stateであり、初期v2は端末間同期しない。

## fixtureとTCK

- 共通TCKは最初のwriteのtriplet、provider-backed lookup、本文とintent markerのsingle write、複数hit、検索miss、binary自動再送禁止を検査する。
- RedmineとJira Cloudのprovider事実はそれぞれの`contract-fixture.ts`へ記録し、同じassertionで検証する。
- Jira live responseはtenant ID、site URL、credentialを除去して`tests/fixtures/jira-cloud-phase2`へ保存した。
- compatibility matrix全行の計画は[`compatibility-test-plan.md`](./compatibility-test-plan.md)を正本とする。
