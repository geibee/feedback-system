# API・packageの互換性

## 2026-09-06 セキュリティ修正の互換境界

- 旧DB保存版は廃止済みであり、DB用の互換・復元・migration経路は提供しない。本repositoryの`legacy` readerはRedmine v1 ticket形式のreaderであり、旧DB版ではない。
- Redmine v1のOpenAPI、保存形式、公開package、自己編集署名、storage keyは変更しない。v2内で未検証のv1 journalはprovider由来の会話として保持し、v2 messageの本文・所有者へ適用しない。v1単独gatewayの動作は維持する。
- Envelopeへ任意の`initialBodyHash`を追加した。新規作成の応答を得た経路は入力本文のhashを署名する。読取り時の改変はintegrity errorとし、hash欠落へfallbackしない。
- hashのない旧Envelopeと、初回writeの応答喪失から本文なしで回収したEnvelopeは読めるが、初期本文をparticipantの検証済み本文へ昇格しない。したがってv2での自己編集対象にしない。既存の署名済みrevisionは所有者・本文hash・chainを検証して最新本文と所有者を復元する。信頼できないprovider本文への自動再署名は行わない。
- browser wire DTOは変更しない。旧v2 readerは新しいEnvelope fieldを拒否し得るため、Connector／Envelope codec／contractsは同時配備する。Redmine v1 rollbackとは区別する。
- profileは任意operationの許可集合を照会し、write権限をreadから推測しない。remote自己編集はread／reviseを別々に束縛し、どちらかの拒否時は書き込まない。
- Controllerは通信前にpending intentを端末内へ保存し、切断・再読込後も同じID／hashで回収する。本文やbinaryの自動再送はしない。


この文書は、API、JSON Schema、公開packageを変更する開発者向けのチェックリストです。個々のfieldやresponseはこの文書へ転記せず、次の正本を確認してください。

汎用化開始時点のpackage export、browser storage key、runtime config、v1／UI characterization、明示的未検証項目は[`docs/phase0/compatibility-ledger.md`](./phase0/compatibility-ledger.md)に固定しています。公開契約の所有境界とv1／v2 security boundaryは[`ADR 0004`](./adr/0004-contract-ownership-and-v1-v2-boundary.md)を参照してください。

| 変更対象 | 正本 |
| --- | --- |
| 汎用Feedback gateway v2 API | [`contracts/feedback/feedback-gateway.openapi.yaml`](../contracts/feedback/feedback-gateway.openapi.yaml) |
| v2 domain／Envelope／profile／authorization | [`contracts/feedback/schemas/feedback-*.schema.json`](../contracts/feedback/schemas) |
| Redmine gateway API | [`contracts/feedback/redmine-gateway.openapi.yaml`](../contracts/feedback/redmine-gateway.openapi.yaml) |
| Redmineのprofile、runtime config、保存形式 | [`contracts/feedback/schemas/redmine-*.json`](../contracts/feedback/schemas) |
| releaseごとの差分 | [`contracts/feedback/CHANGELOG.md`](../contracts/feedback/CHANGELOG.md)と各packageの`CHANGELOG.md` |

汎用browser consumerは`@geibee/feedback-contracts/v2`、server／Connectorは必要に応じて`@geibee/feedback-contracts/v2/server`を参照します。package rootのRedmine v1 exportは置換しません。`ProviderRef`は`@geibee/feedback-connector-sdk`だけのserver-only portであり、browser OpenAPI、client、controller、rendererへ再exportしません。

Phase 1で追加したpackage名と依存方向は次で固定します。

```text
renderer -> feedback-controller -> feedback-client -> feedback-contracts/v2
feedback-service -> feedback-gateway + feedback-connector-sdk + feedback-envelope
feedback-gateway -> feedback-connector-sdk -> feedback-contracts
connector -> feedback-connector-sdk + feedback-envelope
feedback-service-runtime -> feedback-service + jira/redmine connector
```

Redmine releaseの既存10 packageと2 OCI imageは変更しません。新規v2 packageは`private: true`を維持し、Redmine releaseへ暗黙に追加しません。Phase 3でFeedback ServiceがConnector port型とparticipant credentialの共通codecを直接利用するため、private applicationの直接依存に`feedback-connector-sdk`と`feedback-envelope`を追加しました。browser公開契約とprovider実装への依存は追加していません。

## Feedback v2 Contract freeze

Phase 2で`feedback-v2-contract-2.0.0-alpha.1`をfreeze識別子とした。release前の実装監査で公開participant発行経路と署名attachment関連付けの欠落が判明したため、2026-09-01に`feedback-v2-contract-2.0.0-alpha.2`へ訂正した。これはgit tagではなく、未公開alpha契約の版である。詳細とprovider別保証水準は[`docs/phase2/contract-freeze.md`](./phase2/contract-freeze.md)を参照する。

Phase 1 draftからalpha.1までに、次を未公開契約内で修正した。

- intent回収へ`threadId`と完全なresource scopeを必須化した。
- discovery認可targetをprofile／workspace／resourceの3 levelへ分離した。
- message markerへreply／revision kind、event ID、participant ID、body hash、revisionのexpected IDを追加した。
- attachment成功mapping用のserver-only署名schemaを追加した。
- provider authorからprovider内部IDを除き、message／revisionへstable ordering keyを必須化した。
- serverでは算出できない`unreadCount`をwire thread summaryから除き、browser local controller stateへ置いた。
- operationごとの保証をRedmine／Jira Cloudともcreate・replyは`recoverable`、revision・attachment uploadは`best-effort`へ固定した。

v1 API、v1生成型、既存browser storage key、runtime config、公開Redmine package exportは変更していない。Phase 3以降のalpha契約破壊は契約owner承認、全consumer影響確認、OpenAPI／schema／生成型／fixture／CHANGELOGの同時更新を要する。

Phase 3はこのfreezeを変更せず実装した。Feedback Service／gateway、Redmine Connector、Jira Cloud Connector、browser client／headless controllerを追加し、v1 readerはdual-writeで生成されるUUIDv7／UUIDv8を欠落させない範囲だけ受理versionを広げた。Jira Forge entity property indexはConnector配下の独立deploy artifactであり、Feedback Service packageやbrowser packageへ依存させない。

Phase 4もfreezeを変更していない。`@geibee/feedback-react`はcontroller snapshot／command専用renderer、`@geibee/feedback-web-component`はReact非依存の標準custom elementとplugin lifecycle ownerとして追加した。`@geibee/feedback-redmine-react`の既存v1 exportは維持し、v2向け`RedmineFeedbackControllerOverlay`を汎用React rendererの同一参照を返す互換wrapperとして追加した。`<geibee-feedback>`のtag名、`createFeedbackPlugin`、`FeedbackOverlay`はalpha期間中の公開freeze候補であり、Phase 5 acceptance前の破壊変更にはconsumer影響確認を要する。

Phase 5の初回Gateまでは`contracts/feedback`のalpha.1 freezeを変更せず、`@geibee/feedback-service-runtime`をprivate deploy compositionとして追加した。Connector runtime catalogはdeploy用read-only設定で、browser API／DTOではない。Jira Forge entity property indexは引き続きConnector配下の独立artifactである。その後のrelease前監査で次のalpha.2訂正を行った。

### alpha.2 release blocker訂正

- OpenAPIで既に必須だったintent回収の`X-Feedback-Request-Hash`へclient／Service実装を合わせ、URL queryへのhash露出を廃止した。
- `public-profile`専用のparticipant credential発行endpointとclient methodを追加した。same-origin／CSRFを必須とし、他Authorization Modeでは拒否する。
- unsafe operationへ実装済みの`X-Feedback-CSRF: 1`をOpenAPI必須headerとして明記した。
- signed grant Bearerとpublic participant credential headerをOpenAPI security schemeへ明記し、participant発行route自体はcredential不要へ固定した。
- server-only attachment markerへ必須`messageId`を追加した。alpha.1 markerは関連先messageを署名していないためalpha.2 readerでは検証成功として扱わない。
- OpenAPIが許可する`resource.key`の512文字へService実装を合わせた。

public participant wire endpointの追加はadditiveである。一方、未公開alphaの`FeedbackClientPort`へrequired methodを追加したため、独自port実装は`issueParticipant`を実装するsource更新が必要になる。attachment markerの必須field追加はserver保存形式の訂正であるため、既存alpha.1 markerがある環境は[`docs/phase5/storage-migration.md`](./phase5/storage-migration.md)の手順を適用する。

## 利用者が揃えるversion

Redmine構成では、SPAで使う`@geibee/feedback-*`、`@geibee/feedback-redmine-*`とgatewayを同じversionに揃えます。異なるversionを混在させた配備はサポートしません。

React 18または19とbundlerはSPA側で用意します。公開packageはReactやViteを内包しません。gatewayのbase pathは`/internal/feedback-redmine/v1`で、SPAと同じoriginから公開します。

`1.0.0-alpha.7`で旧Feedback Service、旧React UI、管理UI、token broker、関連するAPI／schema／配備物を削除しました。
Redmine構成だけが公開対象です。`FeedbackHostContextV1.locale`の任意性と`FeedbackTargetV1`の5種類のunionは
alpha.3〜alpha.6との公開型互換を維持します。keyなしのDOM追従座標は新しいtarget kindを追加せず、既存の
`custom` variant（providerは`io.github.geibee.feedback.dom`）のscalar metadataへ保存します。旧gatewayは
同じshapeを受理・保存し、旧UIは`fallbackRelativeX/Y`、新UIはmetadataのdocument／scroll content座標を使います。

## 変更時に行うこと

1. 該当するOpenAPIまたはJSON Schemaを先に変更する。
2. `npm --workspace @geibee/feedback-contracts run generate`でTypeScript型を再生成する。
3. gateway、core、利用側packageのcontract testを同じ変更へ追加する。
4. `contracts/feedback/CHANGELOG.md`と変更したpackageの`CHANGELOG.md`へ利用者影響を書く。
5. `bash scripts/verify-feedback.sh`をskip変数なしで実行する。

APIやDTOを変えたのに、正本、生成型、test、CHANGELOGのいずれかが更新されていない変更は完了ではありません。

## versionを上げる判断

| 変更 | 扱い |
| --- | --- |
| 任意fieldや任意endpointの追加 | 同じmajorで追加可能。旧clientの動作をtestする |
| 必須fieldの追加、field削除、型変更、意味変更 | 新しいmajorを用意する |
| runtime configへsecretやRedmineの数値IDを追加 | 実施しない。server profileまたはsecretへ置く |
| gateway path、認証境界、保存形式の非互換変更 | 新しいmajorと移行手順を用意する |
| package内部だけの変更 | 公開型と挙動が変わらないことをcontract testで確認する |

version 1のJSON Schemaはunknown propertyを拒否します。後方互換のつもりでfieldを追加しても、旧gatewayや旧clientが拒否する場合があるため、対応する両方向のtestを追加してください。

## 維持する境界

- browserへRedmine URL、API key、participant署名鍵、project/tracker/custom field IDを渡さない。
- runtime configは`enabled`、`profileId`、同一originのgateway pathと任意の利用者向け案内だけにする。
- thread作成の任意項目はgatewayで有効化したものだけ受け付ける。
- Feedback UIでは投稿、返信、自己編集を扱い、状態、担当者、優先度の変更はRedmineで行う。
- gatewayの`/health/ready`は起動設定だけを確認し、Redmine疎通は`feedback-redmine-ops doctor`で確認する。
- Redmine適合性試験は5.1.12、6.0.10、6.1.3、7.0.0を対象にする。
- Feedback Service内のv1 facadeはserver profileに固定したv2と同じAuthorization Modeを通し、legacy standalone v1の公開participant modeは`public-profile`相当として維持する。mode間fallbackは許可しない。
- v2のworkspace／resource discoveryは現在認可、profile policy、backend capabilityの積集合を超えず、provider IDやURLを返さない。
- create／reply／revision／attachment uploadの結果不明はtyped intent回収へ移し、best-effort操作やbinary uploadを自動再実行しない。
- projectionは候補抽出にしか使わず、Envelope署名、provider binding、scope、現在認可、profile policy、backend capabilityを再検証してから返す。
- Jira／Redmineのfirst-write recovery seedは未信頼候補であり、provider object IDへ束縛した署名Envelopeへ補修するまで正本metadataとして返さない。

保存済みデータや公開APIに影響するか判断できない場合は、互換扱いにせず新しいversionとして設計してください。
