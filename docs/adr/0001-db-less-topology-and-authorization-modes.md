# ADR 0001: DBレス実行topologyとAuthorization Mode

- 状態: 採用
- 決定日: 2026-08-31
- 適用範囲: Feedback Service v2と、同Serviceへ収容するRedmine v1 facade

## 文脈

Feedback本文、会話、証跡、操作回復metadataをFeedback Serviceへ複製すると、新しい正本、migration、backup、監査、障害復旧が必要になる。汎用化ではticket管理システムを正本として維持し、認可方式だけをrequestごとに推測しない境界が必要である。

## 決定

初期v2の実行topologyを次に固定する。

```text
Browser
  -> Feedback Service
       -> v2 HTTP adapter / Redmine v1 facade
       -> in-process gateway application service
       -> profile固定Authorization Adapter
       -> FeedbackRepositoryPort
       -> Connector
  -> 契約済みticket管理システム（正本）
```

- v2 endpointは将来追加する`apps/feedback-service`が提供し、gateway application serviceは同じprocessで動作させる。別gateway process、内部queue、非同期workerを初期topologyへ追加しない。
- Feedback Serviceは専用DB、queue、persistent／shared application data cache、upload directory、private object storageを使用しない。host DBも直接参照しない。
- Feedback本文、初回message、reply、revision、証跡、attachment metadata、操作回復metadataの正本は契約済みticket管理システムとする。
- provider profileと公開capabilityはread-onlyの起動時設定から読む。provider credential、Envelope署名鍵、participant credential署名鍵、participant ID導出鍵はserver-side secret referenceから読む。secretに既定値を設けず、browser、profile本文、logへ出さない。
- JWKSとprovider metadataだけは、件数とTTLに上限のあるin-process cacheを許す。cacheは正本ではなく、process再起動で失ってよい。認可decision、Feedback DTO、provider response、upload bodyは共有cacheへ保存しない。
- readinessはprofile、mode、secret reference、署名設定、provider credentialを読み込めたことまでを検査する。providerの瞬間的な疎通障害はreadiness失敗やprocess再起動理由にしない。
- 最初の抽象検証先と最初の追加ConnectorはJira Cloudに固定する。Jira Data Centerは初期v2の契約freeze対象外であり、Cloud実装内の条件分岐で扱わない。

## DBレス操作回復の境界

- browserはprovider write前にstableな`threadId`、`intentId`、`requestHash`を生成する。
- thread作成の最初のprovider writeは、本文と同じ操作で`threadId`、`intentId`、`requestHash`を保存しなければならない。後続writeでしか保存できないConnectorは、初期v2のDBレスthread作成要件を満たさない。
- ConnectorはFeedback Service再起動後も、providerだけを検索して`threadId`からprovider objectを一意に再解決できなければならない。0件でも検索indexの遅延と不存在を区別できない間は`pending`、複数件は`repair_required`とし、自動作成や自動選択を行わない。
- create、reply、revisionは操作単位で`recoverable`、`best-effort`、`unsupported`のいずれかをcapabilityとConnector文書へ記録する。本文とintent markerを同一writeで保存でき、providerから一意に回収できる操作だけを`recoverable`と呼ぶ。
- Feedback Serviceはexactly-once、不変監査、provider障害中のoffline readを保証しない。結果不明時に安全な不存在を証明できない操作を盲目的に再実行しない。
- attachment uploadのexactly-onceは共通保証にしない。結果不明時にbinary bodyを自動再uploadせず、一意回収できなければ`repair_required`とする。
- draft、follow、unread、pending UI stateはbrowser local/session storageの端末内状態とし、端末間同期を保証しない。
- 検索projectionは候補抽出専用である。返却前にEnvelope署名、schema version、provider binding、request scope、現在の認可、profile policy、backend capabilityを再検証する。projectionだけを正本または認可根拠にしない。

## Authorization Mode

server profileは起動時に次のいずれか一つへ固定する。request parameter、header、path、tokenの有無、上流障害を理由にmodeを変更しない。

| mode | 信頼する認可結果 | 信頼しないもの | 失効と障害時の規約 |
| --- | --- | --- | --- |
| `public-profile` | profile endpointへ到達できる配備境界 | participant credentialを実在人物の認証またはmembership証明として扱わない | 即時の個人失効は提供しない。profile自体を非公開化または停止する |
| `signed-grant` | issuer allowlist、署名、audience、claim、対象を検証した短寿命JWT | browser session、汎用OIDC scope、別profile向けtoken | 失効上限はADR 0002の330秒。検証不能、unknown `kid`、JWKS障害は拒否する |
| `remote-authorization` | mTLSまたはserver credentialで呼ぶ契約済み認可APIの当該request向けresponse | host DB直接参照、過去requestのdecision、browserが送るdecision | requestごとに照会し、2秒でtimeout、同一request内の自動retryなし。timeout、不正response、401/403/429/5xx、network障害はすべてfail-closedとする |

`public-profile`では、現行v1と同じくprofile、一覧、詳細、attachment取得、participant発行、新規投稿をprofile到達境界内で公開できる。v2はsame-origin／CSRF検証済みの`POST /profiles/{profileId}/participants`からbrowser profile UUIDに対するparticipant credentialを発行する。このrouteは`public-profile`だけで有効であり、他modeのcredential取得失敗を理由に利用してはならない。participant credentialはorigin、profile、browser profileに束縛した投稿所有確認であり、返信、自己編集に使用する。他人の投稿編集、利用者本人性、組織membershipは証明しない。

`signed-grant`のclaim、scope、寿命は[ADR 0002](./0002-signed-grant-contract.md)に固定する。`remote-authorization`のHTTP DTOはPhase 1の公開契約で定義するが、次の意味論は変更しない。

- 入力はprofile、workspace、resource、要求operation、subjectを含み、responseは同じ対象へ束縛した許可operationだけを返す。
- decisionをrequest間でcacheせず、remote APIがprofile policyやbackend capabilityを拡張できないようにする。
- 即時失効が必要なprofileは`remote-authorization`だけを使用する。

すべてのmodeで有効権限は次の積集合とする。

```text
effective permissions
  = Authorization Modeが許可したoperation
  ∩ immutable server profile policy
  ∩ backend capability
```

operation語彙は`feedback:read`、`feedback:create`、`feedback:reply`、`feedback:revise`、`feedback:attachment:read`、`feedback:attachment:upload`の6個に固定する。`feedback:attachment:upload`は独立権限であり、createまたはreplyから暗黙に導出しない。

Feedback Service内のv1 facadeとv2は、同じserver profileに固定した同じmodeを必ず通る。`signed-grant`または`remote-authorization`のprofileをlegacy v1 pathだけ`public-profile`としてmountしない。legacy standalone Redmine reference serverだけは、現行互換として`public-profile`相当の境界を維持する。

## 却下した選択肢

- idempotency ledger、認可session、Feedback read model用DBの追加: DBレス運用と正本境界を壊すため採用しない。
- queueまたはworkerによるupload再試行: 結果不明bodyの重複と新しい永続状態を生むため採用しない。
- signed grant失敗時のpublic mode fallback: 認可迂回になるため採用しない。
- host DB直接参照: Feedback Serviceをhost内部schemaと配備へ結合するため採用しない。

## 帰結

providerが最初のwriteで回復metadataを保存できない、または`threadId`を一意検索できない場合、そのprovider／操作は初期v2 Connectorの最低条件を満たさない。強い監査、offline read、端末間state同期、即時失効が必要な利用者は、それぞれprovider側機能または`remote-authorization`を選ぶ必要がある。
