# Phase 1 契約freeze候補

記録日: 2026-08-31

この文書はPhase 2のfixture／TCK／Jira Cloud contract spikeで検証する候補を固定する。Phase 1では本番Connector、HTTP adapter、codec、controller state machineを実装しない。

## 型とpackage境界

- 公開契約の正本は`contracts/feedback`だけとする。Redmine v1はpackage root、汎用browser v2は`@geibee/feedback-contracts/v2`、Envelope、profile、projection、authorization等のserver-only生成型は`@geibee/feedback-contracts/v2/server`から参照する。
- `ProviderRef`は`@geibee/feedback-connector-sdk`だけが公開するserver-only implementation portである。browser OpenAPI、client、controller、rendererへprovider key、object ID、event ID、canonical URLを公開しない。
- package内の手書きinterfaceはHTTP／schema型の複製ではなく、`FeedbackClientPort`、`FeedbackRepositoryPort`、authorization、profile loader、Envelope codec、controller等のimplementation portとする。

## workspace／resource discovery

- workspace discoveryはserver profileの`workspacePolicy.workspaceIds`を上限とし、Authorization Modeの対象とbackend capabilityを超えて列挙しない。
- `signed-grant`ではgrantへ完全一致するworkspace／resourceだけを返す。discovery possessionを別workspaceへアクセスするgrantとして扱わない。
- resource discoveryはFeedback stableな`{kind,key}`だけを返す。provider object ID、provider URL、provider cursorをbrowser DTOへ含めない。
- discoveryがbackendで提供されない場合はprofile capabilityを`unsupported`としてfail-closedにし、別provider、別profile、host DBへfallbackしない。
- page cursorはquery fingerprintと`occurredAt`／stable IDのordering boundaryへ束縛し、別profile、workspace、resource、filter、sortへ流用できないopaque tokenとする。

## 認可とattachment upload

有効権限は次の積集合だけで決める。

```text
Authorization Mode decision
  ∩ immutable server profile policy
  ∩ backend capability
```

- profileは`public-profile`、`signed-grant`、`remote-authorization`の一つだけを持つ。credential欠落、JWKS障害、remote timeout、不正responseを理由に別modeへfallbackしない。
- browserが送るsubject、Authorization Mode、authorization decisionを信頼しない。remote authorizationのsubjectは認証済みserver adapterだけが作る。
- attachment uploadは独立endpointとし、必ず`feedback:attachment:upload`を要求する。`feedback:create`、`feedback:reply`、`feedback:read`から導出しない。
- upload streamは認可の積集合を通過するまで読まない。結果不明時のbinary自動再送回数は0、単一requestのprovider upload試行上限は1とする。

## operation保証とintent回収

create、reply、revision、attachment uploadはprofile capabilityで個別に次の一つへ分類する。

| 値 | 意味 |
| --- | --- |
| `recoverable` | 本文とintent markerを同じwriteで保存でき、providerだけから一意回収できる |
| `best-effort` | 操作は可能だが結果不明時の安全な一意回収を共通保証できない |
| `unsupported` | backendが操作を実装しない |

- thread作成の最初のprovider writeへ`threadId`、`intentId`、`requestHash`を同時保存する。`threadId`からticketをprovider上で一意に再解決できないConnectorは初期v2対象外とする。
- 完了結果は`created`、`recovered`、`already_applied`、結果不明はHTTP 202の`pending`または`repair_required`として返す。検索index遅延中の0件を安全な`not_found`と扱わない。
- 同じintentの`requestHash`不一致は409 `feedback.conflict`、複数hitは`repair_required`とし、自動選択または自動writeを行わない。
- command hashは`UTF8("feedback-command\n2\n") || RFC 8785(command input)`のSHA-256とする。`requestHash`自身は入力から除外し、profile、workspace、resource、operation、intent ID、stable result ID、binary uploadではcontent hashとmetadataを含める。

## projection検証

projectionは候補抽出専用の未信頼値であり、正本、認可decision、回復完了の根拠にしない。検索hitごとに次の順で検証する。

1. Envelope schema version
2. Envelope署名と`kid`
3. provider bindingと実objectの完全一致
4. requestのprofile、workspace、resource scope
5. request時点のAuthorization Mode decision
6. immutable server profile policy
7. backend capability

一つでも失敗したcandidateをserializeしない。invalid v2 Envelopeが存在する場合はlegacy markerへfallbackしない。同じstable IDのvalid候補が複数ある場合は`repair_required`とする。

## Phase 2で実測する項目

Jira CloudはREST API v3だけを対象とし、次は管理されたtest tenantのlive write前には確定扱いにしない。

- create、reply、revisionを`recoverable`または`best-effort`のどちらで公開できるか
- issue／comment propertyの検索反映遅延と安全な`not_found`判定
- attachmentを`attachmentId`／`intentId`から一意回収できる条件
- timeout後のissue、comment、attachment回収と複数hitの反例

live writeにはissue／comment／attachment作成権限を明示した別promptを必要とする。Phase 1は外部writeを行わずHard Gate 1で停止する。
