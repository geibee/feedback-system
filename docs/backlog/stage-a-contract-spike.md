# Backlog Stage A DBレスcontract applicability spike

確認日: 2026-09-02

## 判定

管理されたBacklog SaaS無料体験spaceでlive Gateを実行し、Stage A Hard Gateは**通過**した。create、reply、append-only revisionは、provider write後のresponseを破棄してもBacklogだけから一意回収でき、別processからprovider IDを受け渡さずthread、Envelope、会話、revisionを再構築できた。この3操作を`recoverable`とする。

attachmentは一時upload IDとissueへattach後の最終IDが異なった。最終commentとbinary hashは回収できても、既存の署名済みattachment markerを最終provider IDへ同一writeで束縛できない。このためattachment read／uploadを`unsupported`とし、backend capabilityへ公開しない。DB、queue、cache、object storage等による補完は行わない。この縮退を含めてStage Bへ進む。

## Stage B live Conformance

4つ目の任意Text custom field `feedback.resourceKey`をprovisionした後、実際の`@geibee/feedback-connector-backlog`を通るStage B live Conformanceを2026-09-02に完了した。create、reply、append-only revisionの各commit後にtransport responseを破棄し、Backlog上の4 custom field、description、comment markerだけから結果を回収した。resource検索、本文と署名metadataの再読込、複数thread候補の`repair_required`、provider object IDを渡さない別process再構築、attachment read／uploadの`unsupported`、全run-owned issueのcleanupも同じrunで確認した。

Backlog検索は作成後に一時的な0件を返し、別processでも可視化時刻が揺れることを観測した。write前はread-onlyで連続して一意候補が見えることを確認し、commit後は自動再書込みをせずrecover-onlyとする。0件を不存在証明に昇格させない。匿名化した証跡は`tests/fixtures/backlog-stage-b/live-conformance.json`へ保存し、Connector、transport、DTO mapping、provisioning、runnerのsource digestへ束縛する。

また、custom field定義APIはText種別を`typeId`で返す一方、issue DTO内のcustom field値は実環境で`fieldTypeId`を返した。両wireの差はBacklog REST clientのDTO mappingだけへ閉じ込める。

## 調査境界

- 対象はBacklog SaaSのBacklog API v2とする。Jira Data Centerは対象外である。
- Feedback本文、会話、revision、証跡、attachment metadata、操作回復metadataはBacklogだけを正本候補とする。
- DB、queue、persistent／shared cache、object storage、upload directory、host DB参照による補完は候補に含めない。
- 公開APIが明記する事実、そこから導くConnector mapping、live確認が必要な仮説を分離する。
- 公開契約、OpenAPI、生成型、provider profile DTO、環境設定は変更しない。

公開資料からのprovider事実は`tests/fixtures/backlog-stage-a/provider-facts.json`、匿名化した実測結果は`tests/fixtures/backlog-stage-a/live-gate.json`とする。前者は合成値だけを持ち`liveSpaceObserved=false`を保持し、後者は現source digest、Hard Gate判定、cleanup結果を持つ。tenant、project、issue、comment、attachment、account、credentialの識別子は保存しない。

## provider APIの事実とmapping

### 最初のthread write

`POST /api/v2/issues`は`description`と`customField_{id}`を同じ`application/x-www-form-urlencoded` requestへ受ける。次の配置をStage A候補として固定する。

| Feedbackデータ | Backlog保存位置 | 性質 |
|---|---|---|
| Feedback本文、最初のmessage、thread、scope、証跡metadata | `description`内の本文、recovery seed、署名済みFeedback Envelope | 正本 |
| `threadId` | 専用Text custom field | 検索projection |
| createの`intentId` | 専用Text custom field | 操作回復projection |
| createの`requestHash` | 専用Text custom field | 操作回復projection |

3 custom fieldはEnvelopeの代替ではない。provider object IDは作成前に得られないため、最初のwriteでは本文、未信頼recovery seed、3 fieldを同時保存する。response取得またはseed検索回収後、同じissueのdescriptionへprovider object IDに束縛した署名済みEnvelopeを補う。これは既存ADRの二段階bindingであり、最初のwriteにtripletを後付けする設計ではない。custom fieldを利用者が変更できることを認可根拠または完全性根拠にしない。

live runでは同じissue作成requestの`description`と全custom fieldがdirect readで完全にround-tripした。保存済み最終runではcustom field検索がexact post-filter後に24.751秒で1件となった。この値は観測値であってSLAではないため、0件は引き続き`pending`とし自動再作成しない。

### thread検索と一意再解決

`GET /api/v2/issues`はproject filter、Text custom fieldの`customField_${id}=Keyword`、`count`、`offset`を受ける。Connector候補は次の順で処理する。

1. project IDとthread custom fieldで全pageを検索する。
2. responseのcustom field値を要求`threadId`と完全一致で再filterする。
3. 0件は`pending`とし、自動再作成しない。
4. 1件は署名済みEnvelope、provider binding、scope、`threadId`を検証してから採用する。
5. 2件以上は`repair_required`とし、先頭、最新、最小issue IDを自動選択しない。

Backlog custom fieldに一意制約はないものとして扱う。公開資料にread-after-write上限がないため、0件を安全な不存在証明にしない。custom fieldが未provisionの場合にdescriptionや全issueを常用走査するfallbackは設けない。

### replyとrevision

`POST /api/v2/issues/{issueIdOrKey}/comments`は`content`を同じcomment作成requestへ受ける。replyは利用者本文と署名済みmessage／intent markerを`content`へ同梱する。

revisionは`PATCH`による既存comment上書きを使わず、署名済みrevision Envelopeを持つappend-only commentとして追加する。これにより旧本文とrevision chainもBacklogに残し、既存Envelopeのappend revisionモデルを再利用する。既知issueのcommentを`minId`／`maxId`と`count`でpage走査し、marker一致候補を検証する。

live runでcomment本文と署名markerのround-trip、response破棄後の回収、0件の`pending`、同一intent 2件の`repair_required`、cleanup後の一意回収を確認した。revisionは既存commentを変更せずappend-only commentとして回収できた。最大長とpagination中の同時追加にprovider SLAはないため、page上限と0／複数件のfail-closed判定は維持する。

### attachmentと証跡

Backlog APIのattachmentは二段階である。

1. `POST /api/v2/space/attachment`へbinaryを送り、一時attachment IDを得る。
2. `POST /api/v2/issues/{issueIdOrKey}/comments`へ、一時IDを`attachmentId[]`として、署名済みattachment mappingを`content`として同梱する。

最終commentでは一時attachment ID、Feedback `attachmentId`、message ID、content hash、size、media typeを署名対象とする候補を置いてlive確認した。一時IDと最終issue attachment IDは異なり、同じfinal writeへ最終IDの署名済みmappingを載せられなかった。attachment upload／readは`unsupported`へ落とし、binaryとmetadataをBacklog外へ補完しない。

最初のbinary upload requestにはFeedback `attachmentId`、`intentId`、`requestHash`、idempotency keyを同梱する欄がない。live faultではresponseを破棄してbinaryを自動再送せず、test harnessだけが保持したIDをcleanup対象issueへattachして削除した。Connectorからは一時IDを一意回収できないため、この経路は`repair_required`である。最終commentのresponse喪失とdownload content hashは回収できたが、最終ID binding不成立を補えないためattachment操作自体を公開しない。

添付上限はspace planで異なり、公開サポート資料上の表記はFree planが5 MB、Starter以上が10 MBである。runtime profile値はlive spaceのplan以下へ固定し、静的fixtureは単位解釈にも安全側の5,000,000 bytesを使う。

## capability／保証水準

live Gate後の分類は次のとおりである。

| 操作 | 暫定分類 | markerと回収 | Hard Gate後の強化候補 |
|---|---|---|---|
| create | `recoverable` | 本文とtripletを同じissue createへ指定。response破棄後はcustom field検索、exact filter、Envelope補修 | 0件は`pending`、複数件は`repair_required` |
| reply | `recoverable` | 本文とmarkerを同じcommentへ指定しpagination回収 | 0件は`pending`、複数件は`repair_required` |
| revision | `recoverable` | append-only revision commentへ本文とmarkerを同梱 | replyと同じ判定、旧commentを上書きしない |
| attachment read／upload | `unsupported` | 一時IDと最終IDが異なり署名済みprovider mapping不成立 | backend operationへ公開せず、binary自動再送もしない |

`exactly-once`、provider障害中のoffline read、不変なprovider側監査は保証しない。

## Authorization Modeとcredential

Stage Aのmanaged test profileは既存の`signed-grant`へ固定し、mode fallbackを許可しない。Backlog credentialはserver-side secretのAPI keyとし、transportだけが`Backlog-API-Key` headerへ変換する。live readinessでheaderがHTTP 200、BearerがHTTP 401であることを確認した。公式の`apiKey` query parameterもHTTP 200だが、URL、access log、error reportへの露出を避けるためConnectorでは使用しない。

membership、認可decision、操作状態は保存しない。effective permissionはsigned grant、server profile policy、Backlog credential主体のproject権限、backend capabilityの積集合とする。将来`public-profile`または`remote-authorization`を使う場合も、profileごとの既存mode選択でありBacklog Connector内のfallbackではない。

## provisioning／readiness

Stage Bでも、次を満たさないprofileはfail-closedな`configuration_error`とする。live readinessでは専用project、3 Text custom field、project administrator credential、issue type、priorityを確認した。

- 同じBacklog projectに専用Text custom fieldを3個作成し、field IDをruntime profileへ設定する。
- 3 fieldの`typeId=1`、対象issue typeへの適用、重複field IDなしを`GET /api/v2/projects/{projectIdOrKey}/customFields`で確認する。
- project ID、issue type ID、priority ID、custom field IDをprovider profileのread-only設定として扱う。
- credential主体がprojectを参照し、issueとcommentを追加できることをreadinessまたはmanaged live testで確認する。
- configured attachment上限がspace planの上限以下であることを運用設定で固定する。

custom fieldが使えないspace／planをDBやdescription全走査で補わない。そのprofileではDBレスcreate要件を満たせず、Backlog Connectorをreadyにしない。

Stage Bのresource単位thread一覧では、3 fieldだけでthread fieldのscope prefix検索もlive確認したが候補を返さなかった。全project issueの常用走査へfallbackせず、4つ目の任意Text custom field `feedback.resourceKey`へapplication、environment、resourceの決定的hashを保存し、完全一致検索する。Stage B readinessはこのfieldも必須とする。

## 既存共通部品の再利用表

| 既存部品 | Stage Aでの適用 | Backlog固有処理を置かない理由 |
|---|---|---|
| `contracts/feedback` | v2 wire／domain DTO、operation guarantee、problemを変更せず使用 | provider DTOを公開契約へ漏らさない |
| `feedback-envelope` | issue description、comment、attachment mappingのcanonical codec／署名／revision chain | Backlog本文はEnvelope carrierにすぎない |
| `feedback-connector-sdk` | `FeedbackRepositoryPort`と既存Connector TCKを変更せず使用 | recovery stateとerror意味はprovider非依存 |
| `feedback-gateway` | authorization orchestration、capability積集合、0／複数件回収判定を再利用 | Backlog検索構文はrepository内へ閉じる |
| `feedback-client` | v2 HTTP transportとproblem mappingをそのまま使用 | browserへBacklog wireを出さない |
| `feedback-controller` | pending intent、明示回収、best-effort表示をそのまま使用 | browser stateはprovider非依存 |
| React／Web Component renderer | 変更なし | capabilityとcontroller snapshotだけを見る |
| Feedback Service | 公開API、DTO、DBレス境界を変更しない | Connectorはserver-side registryから解決する |

## Stage Bで必要になる共通拡張

Stage A調査で新しい公開契約やEnvelope形式の必要性は確認されなかった。一方、現在のproduction runtimeにはRedmine／Jira Cloudを直接分岐するcomposition、catalog validation、credential validationが残る。Stage BではBacklog分岐を足さず、先に次のprovider非依存registryへ移す。

- `connectorKey`ごとのruntime profile parser／validator登録。
- server secret文字列からopaque connector credentialを検証するcredential resolver登録。
- runtime profile、participant ID、credential、Envelope codecから`FeedbackRepositoryPort`を作るfactory登録。
- backend capabilityとprofile設定のdrift validator登録。

RedmineとJira Cloudを同じregistryへ移すregression testを先に追加する。Feedback Service、gateway、client、controller、rendererにはBacklog固有の`if`／`switch`を追加しない。

## Connector固有実装の最小一覧

Hard Gate通過後に`feedback-connector-backlog`が所有できる処理を次へ限定する。

- Backlog API v2のform／multipart transportとrate-limit header変換。
- server credentialの`Backlog-API-Key` header wire変換。
- project、issue、custom field、comment、attachment DTOのruntime検証とv2 mapping。
- Text custom fieldを使うissue検索、comment pagination、exact post-filter。
- issue description／comment content／4 custom fieldのmetadata配置。
- custom field、issue type、priority、attachment limitのprovisioning／readiness。

Envelope codec、Authorization Mode、intent recovery state machine、stream上限、共通error、browser state、rendererは再実装しない。

## live Hard Gate手順

専用test spaceとcleanup可能なproject、server-side API keyを用意して次を実行する。credential、space ID、project ID、account、実在本文はfixtureへ保存しない。

1. 3つのText custom fieldをprovisionし、field type、issue type適用、検索可能性を確認する。
2. descriptionに本文と未信頼recovery seed、3 fieldにtripletを指定してissueを単一POSTで作り、direct readで全値を検証する。provider object ID解決後に同じissueへ署名済みEnvelopeを補う。
3. 作成直後からcustom field検索をpageし、完全一致候補が見えるまでの遅延を記録する。
4. providerがwriteを受理した後にclient responseを破棄し、issue IDなし、thread IDだけから回収する。自動再作成しない。
5. 同じthread IDを持つissueを2件作り、`repair_required`になり自動選択しないことを確認する。
6. replyとappend revisionで本文＋markerのround-tripを確認し、response喪失後にcomment paginationだけで0／1／複数候補を判定する。
7. attachmentの一時upload response喪失と、最終comment response喪失を別々に注入する。binaryを自動再送せず、最終mappingとdownload content hashを確認する。
8. Connector processを終了し、別processからserver secretとread-only profileだけを読み、thread、全会話、revision、証跡、attachment metadata、操作結果を再解決する。

上記を2026-09-02に実施し、現source digest付き匿名化fixtureと全run-owned issueのcleanupを確認した。attachmentの失敗境界も隠さずfixture化し、unsupported capabilityとしてHard Gateを通過した。静的TCK成功だけを通過根拠にはしていない。

## 公式資料

すべて2026-09-02確認。

- [Add Issue](https://developer.nulab.com/docs/backlog/api/2/add-issue/)
- [Get Issue List](https://developer.nulab.com/docs/backlog/api/2/get-issue-list/)
- [Get Custom Field List](https://developer.nulab.com/docs/backlog/api/2/get-custom-field-list/)
- [Add Custom Field](https://developer.nulab.com/docs/backlog/api/2/add-custom-field/)
- [Add Comment](https://developer.nulab.com/docs/backlog/api/2/add-comment/)
- [Get Comment List](https://developer.nulab.com/docs/backlog/api/2/get-comment-list/)
- [Update Comment](https://developer.nulab.com/docs/backlog/api/2/update-comment/)
- [Post Attachment File](https://developer.nulab.com/docs/backlog/api/2/post-attachment-file/)
- [Authentication & Authorization](https://developer.nulab.com/docs/backlog/auth/)
- [Rate Limit](https://developer.nulab.com/docs/backlog/rate-limit/)
- [How to attach files to issues in Backlog](https://support.nulab.com/hc/en-us/articles/8683971547801-How-to-attach-files-to-issues-in-Backlog)
