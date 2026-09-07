# Feedback System 汎用化実装計画

参照設計: [`feedback-system-generalization-design.md`](feedback-system-generalization-design.md)

本書は実装順序、契約freeze、PR所有境界、検証gateの正本とする。参照設計と実装順序が異なる場合は本書を優先する。

## 1. 目的

既存のRedmine向けFeedback機能を維持しながら、UI frameworkとticket管理製品に依存しない汎用Feedback基盤へ段階的に移行する。

最終的には、業務アプリ上の画面、resource、位置に紐づくFeedback Threadを、交換可能なticket管理システムを正本として管理できるようにする。

```text
Browser
  ↓ FeedbackClientPort
Headless Feedback Controller
  ↓ generic wire contract
Feedback Service / Gateway Application Service
  ├─ Authorization Adapter
  │    ├─ public-profile
  │    ├─ signed-grant
  │    └─ remote-authorization
  └─ FeedbackRepositoryPort
       ↓
Ticket System Connector
```

## 2. 非交渉の原則

- 既存のRedmine gateway v1と公開packageを直ちに破壊しない。
- 汎用APIは`/internal/feedback/v2`としてv1と並設する。
- Feedback本文、会話、証跡、操作回復metadataの正本はticket管理システムに置く。
- Feedback Serviceはexactly-once、不変監査、provider障害中のoffline readを提供しない。これらが必要な場合はticket管理システム側の機能または別の契約済み基盤を使用し、Feedback Service内へDBや永続storeを追加しない。
- Feedback ServiceはDB、queue、persistent／shared application data cache、upload directory、private object storageを使用しない。
- provider profileはread-only設定から、credentialと署名鍵はserver-side secretから起動時に読み込む。
- Authorization Modeは`public-profile`、`signed-grant`、`remote-authorization`のいずれかをserver profileごとに固定する。
- `public-profile`は現行v1と同じ到達境界とし、participant credentialを実在人物の認証として扱わない。
- `signed-grant`は直接OIDCまたは契約済みtoken exchange JWTの短寿命grantに限定する。
- `remote-authorization`は契約済み認可APIのみを呼び出し、host DBを直接参照しない。
- 操作権限はAuthorization Modeの許可、server profile policy、backend capabilityの積集合とする。
- browserへprovider URL、API key、署名鍵、provider内部ID、provider REST DTOを公開しない。
- APIまたはDTOの変更では、OpenAPI、生成型、互換性文書、CHANGELOGを同じ変更で更新する。
- 設定を追加した場合は`docs/environment-variables.md`を更新し、secretに既定値を設けない。
- 正規の検証入口は`bash scripts/verify-feedback.sh`とし、未検証を成功として扱わない。
- 契約freeze前はconsumerの本実装を開始しない。freeze後の破壊的変更は契約ownerが影響範囲を再評価してから行う。

## 3. 現状と目標の対応

| 現状 | 課題 | 目標 |
| --- | --- | --- |
| `contracts/feedback/redmine-gateway.openapi.yaml` | 共通型がRedmine生成型に依存する | 汎用OpenAPIと共通schemaを追加し、v1契約は互換用に残す |
| `packages/feedback-redmine-core` | 公開model、browser state、Redmine clientが混在する | 汎用domain、browser client、controller、Redmine Connectorへ分離する |
| `packages/feedback-redmine-gateway/src/handler.ts` | handlerがRedmine clientを直接生成する | application serviceがregistry経由で`FeedbackRepositoryPort`を利用する |
| `packages/feedback-redmine-react/src/overlay.tsx` | 通信、状態機械、証跡処理、JSXが集中する | transport、ClientStateV2、Headless Controller、rendererへ分割する |
| `packages/feedback-redmine-plugin` | vanilla利用でもReact runtimeが必要になる | Web Componentを標準rendererにする |
| 公開modelのprovider参照 | provider内部IDやURLがbrowser DTOへ漏れる | server内部`ProviderRef`とbrowser向け`FeedbackThreadRef`を分離する |
| Redmine固有custom field | 他providerへ一対一移植しにくい | 署名付きEnvelopeと小さな検索projectionへ分離する |
| 公開participant modeのreference server | profileへの到達を認可境界とする | 同じ意味論をv2の`public-profile` modeとして明示的に維持する |

## 4. 初期対象と対象外

### 4.1 初期対象

- 汎用wire／domain契約v2
- server向け`FeedbackRepositoryPort`
- browser向け`FeedbackClientPort`
- controller snapshot／command契約
- Connector SDKとconformance test kit
- DBレスのstateless Feedback Service
- `public-profile`、`signed-grant`、`remote-authorization`のAuthorization Adapter
- read-only provider profile／secret loader
- OIDC／token exchange grantの署名検証と対象照合
- Redmine Connectorとv1互換facade
- Jira Cloud Connector
- Headless Controller
- Web Component
- React互換renderer

### 4.2 後続対象

1. Backlog Connector
2. Azure DevOps Connector
3. GitLab Connector
4. GitHub Issues Connector
5. 案件・利用要望に応じたJira Data Center／ServiceNow／Linear Connector
6. Community Connector向けSDKと文書

BacklogをRedmine／Jira Cloudに続く最初の後続Connectorとする。Jira Data CenterはJira Cloud対応の完了から自動的に着手せず、導入案件または明示的な利用要望がある場合だけStage Aから評価する。上記の順序は実装優先順位であり、未検証providerの互換性を示すものではない。

#### 後続Connectorの共通化原則

- 後続Connectorは、Redmine／Jira Cloudで固定したv2 wire／domain契約、`FeedbackRepositoryPort`、Envelope、Authorization Mode、Connector TCKをそのまま適用することから始める。providerごとの公開API、browser DTO、controller command、renderer分岐を追加しない。
- Feedback Service、gateway application service、client、controller、rendererへprovider名による`if`／`switch`を追加しない。Connector追加はserver-side registryへのadapter登録だけで完結させる。
- Envelope検証、stable ID、intent回収状態、request hash照合、署名済みattachment mapping、stream上限、共通error正規化のようなprovider非依存処理は、`feedback-envelope`、`feedback-connector-sdk`、`feedback-gateway`またはruntime共通層へ置く。
- 各Connectorが所有するのは、provider固有のHTTP transport、credential wire形式、provider DTOの検証／変換、検索構文、metadata保存位置、必要なprovisioningに限定する。
- Redmine／Jira Cloudと同じ意味を持つ処理を新Connectorへ複製しない。二つ以上のConnectorで成立する処理は共通層へ抽出し、Backlogを含む第三のproviderで抽象の妥当性を検証する。一方、provider固有の事実を将来予測だけで共通契約へ持ち上げない。
- provider能力が共通契約を満たさない場合は、capability、creation field、`recoverable`／`best-effort`／`unsupported`で表現する。補完用DB、queue、永続cache、object storage、host DB参照は追加しない。

### 4.3 初期対象外

- 既存Redmine ticketの一括書き換え
- 全providerの最低共通機能だけに合わせた機能削減
- Feedback本文や証跡をserver-side DBへ複製すること
- membership DB、idempotency DB、provider検索indexの新設
- hostアプリのDBや内部認証sessionへの直接依存
- v1 APIと既存Redmine packageの即時削除
- Jira Data Center Connector、およびJira CloudとData Centerを一つの実装で同時に成立させること
- 複数端末間でのdraft、follow、unread同期

### 4.4 初期v2の保証範囲

次は初期v2に限った保証境界であり、すべての将来versionやproviderへ一般化しない。

- exactly-once、不変監査、provider障害中のoffline read、端末間のdraft／follow／unread同期は提供しない。
- thread作成時は、最初のprovider writeへ`threadId`、`intentId`、`requestHash`を同じ操作で同時に保存する。
- DBレスConnectorの最低条件として、Feedback Service再起動後もprovider上の検索だけで`threadId`からticketを一意に再解決できることを要求する。
- create、reply、revisionはprovider能力ごとに`recoverable`または`best-effort`とし、実装しない操作だけを`unsupported`とする。結果不明時に安全な不存在を証明できない操作は自動再作成しない。
- attachment uploadのexactly-onceは共通保証にせず、結果不明時にbinary bodyを自動再uploadしない。一意回収できない結果は`repair_required`として扱う。
- 検索projectionは候補抽出専用とし、Envelope署名、provider binding、request scope、現在のAuthorization Mode、server profile policy、backend capabilityを検証してから返す。
- attachment uploadには独立した`feedback:attachment:upload`権限を使用し、create、reply、readの許可から暗黙に導出しない。

## 5. Phase 0で固定する実行トポロジ

### 5.1 v2実行主体

初期v2は次の構成に固定する。

```text
Browser
  ↓ public profile access / OIDC access token / token exchange JWT
Feedback Service
  ├─ v2 HTTP adapter
  ├─ gateway application service（in-process）
  ├─ Authorization Adapter
  ├─ read-only provider profile / secret loader
  └─ FeedbackRepositoryPort → Connector → provider
```

- `apps/feedback-service`がv2 endpointを提供する。
- 汎用gateway application serviceはFeedback Serviceと同一processで実行する。
- Feedback ServiceはDB、queue、persistent／shared application data cache、upload directory、private object storageを使用しない。有界なin-process JWKS／provider metadata cacheは正本とせず、再起動で破棄できるものに限る。
- Feedback本文、message、revision、attachmentの正本はproviderに置く。
- provider profileと公開capabilityはread-only設定から読み込み、provider credentialと署名鍵はsecret referenceで取得する。
- `apps/feedback-redmine-gateway-reference`はlegacy v1 standalone deploymentとして残し、同等の認可意味論をv2の`public-profile` modeで実装する。
- Feedback Service内のv1 facadeとv2は同じserver profileのAuthorization Modeを通し、pathごとの意図しないmode切替を許さない。

### 5.2 Authorization Modeと状態の正本

- `public-profile`は現行v1と同等に、profile endpointへの到達を認可境界とする。participant credentialは発行時にDBへ保存せず、origin、`profileId`、browser profile IDへ署名する。
- `signed-grant`は署名付きtoken自体を認可判定の正本とし、Feedback Serviceはserver-side認可状態、refresh token、revocation listを保持しない。
- `remote-authorization`は契約済み認可APIのresponseをrequestごとの正本とし、host DBを直接参照しない。timeout、不正response、上流障害はfail-closedとする。
- modeはserver profileごとに起動時固定し、request parameter、path、tokenのmode変更は拒否する。
- server profile policyはmodeと独立したimmutableなoperation allowlist、resource制約、provider capability上限とし、Authorization Adapterがその上限を拡張できないようにする。
- provider profileの正本はread-only JSONまたは同等のimmutableな起動時設定とする。secretはprofile本文へ埋め込まず、secret referenceで解決する。
- readinessはprofile、Authorization Mode、署名鍵／JWKS設定、provider credentialの読み込み済み状態を検査する。provider上流の瞬間障害をprocess再起動判定に使わない。

### 5.3 token契約

`signed-grant`のADRで次を値まで固定し、認証fixtureとしてversion管理する。

- 許可するissuerのallowlist
- Feedback Service専用audienceの完全一致規則
- 必須claim: `iss`、`sub`、`aud`、`exp`、`iat`、`scope`
- token exchange JWTで要求するactor／client claimと信頼境界
- clock skew、token最大寿命、JWKS cache、unknown `kid`、鍵取得失敗時の規約
- grant語彙: `feedback:read`、`feedback:create`、`feedback:reply`、`feedback:revise`、`feedback:attachment:read`、`feedback:attachment:upload`
- `feedback:attachment:upload`は独立したupload endpointに必須とする。thread作成またはreplyの許可だけからattachment uploadを暗黙に許可しない。
- grantに必須の`profileId`、`workspaceId`、許可operation、resource scopeの型と最大サイズ
- requestの`profileId`／`workspaceId`／resourceとgrantを完全一致で照合する規約
- token最大寿命と再発行規約。Feedback Serviceはrefresh tokenとrevocation listを持たない

認可式は次とする。

```text
effective permissions
  = authorization modeが返す許可operation
  ∩ server profile policy
  ∩ backend capability
```

### 5.4 Jira検証対象

- 最初の抽象検証先はJira Cloudに固定する。
- Jira Cloudのcontract spikeおよび正式Connectorの完了を、Jira Data Center実装の着手条件とはしない。
- Jira Data Centerは既定ロードマップへ含めず、導入案件または明示的な利用要望がある場合だけ、後続Connector追加計画のStage Aで対象versionと互換性を検証する。
- Stage A前にCloud互換を仮定せず、Cloud ConnectorへData Center固有の条件分岐を追加しない。既存のprovider非依存処理を再利用したうえで、Connector固有実装の要否と最小境界をStage Aの事実から決定する。

## 6. 契約freezeに必要な正本

契約は型名だけでなく、操作意味論、失敗、ordering、streamingまで固定する。

### 6.1 正本ファイルと所有者

| 契約 | 正本 | consumer |
| --- | --- | --- |
| v2 HTTP wire契約 | `contracts/feedback/feedback-gateway.openapi.yaml` | Feedback Service、browser transport、fixture server |
| domain／Envelope schema | `contracts/feedback/schemas/**` | Connector、gateway、client state |
| server port | `packages/feedback-connector-sdk` | gateway application service、Connector |
| browser port | `packages/feedback-client` | controller、renderer host |
| controller契約 | `packages/feedback-controller`のcontract-only entry point | React、Web Component、plugin |
| authorization契約 | `packages/feedback-gateway`のcontract-only entry point | Feedback Service、Authorization Adapter |
| provider profile schema | `contracts/feedback/schemas/**` | profile loader、Connector registry、運用tool |

同じ概念の手書き型を複数packageへ複製しない。OpenAPI／schemaから生成できる型は生成物を参照する。

### 6.2 query、command、page、cursor

少なくとも次をfreeze対象とする。

- query: `GetProfileQuery`、`ListThreadsQuery`、`GetThreadQuery`、`RecoverIntentQuery`、`GetAttachmentQuery`
- command: `CreateThreadCommand`、`ReplyCommand`、`AppendRevisionCommand`、`UploadAttachmentCommand`
- page: `Page<T> = { items, nextCursor }`
- cursor: opaqueなversion付き文字列。consumerは解析・合成しない。
- cursorはquery fingerprintとstable sort boundaryを含み、別queryへの流用を`feedback.cursor_invalid`で拒否する。
- thread／eventのorderingはtimestampだけに依存せず、stable IDをtie-breakerにする。
- cancellationは全portで`AbortSignal`を受け、cancel後の結果をstateへcommitしない。

### 6.3 create、reply、revision、intent回収

- browserは各writeにUUIDの`intentId`を一度だけ生成し、retryでも再利用する。
- create時の`threadId`、reply／revision時の`messageId`／`eventId`、upload時の`attachmentId`はprovider採番に依存しないstable IDとする。
- write成功は共通`CommandResult`で返し、`disposition`を`created`、`recovered`、`already_applied`で表現する。
- optimistic conflictはHTTP 409と`feedback.conflict`で返し、可能な場合は`currentVersion`を含める。
- 結果不明時は同じcommandの盲目的な再発行ではなく、`intentId`で回収する。
- `IntentRecoveryResult.state`は`not_found`、`pending`、`completed`、`repair_required`とする。
- `pending`は`retryAfterSeconds`を返す。`repair_required`は自動的に新ticketを作らない。
- `not_found`はConnectorが安全な再作成を証明できる場合だけ返し、検索indexの遅延と区別できない間は`pending`とする。
- provider検索がbest-effortの場合はcapabilityに明示し、検索miss後の自動再作成を禁止する。初期対象では操作ごとに`recoverable`、`best-effort`、`unsupported`のいずれかをConnector文書へ記載する。
- Feedback Serviceはidempotency ledgerを保持せず、`threadId`、`intentId`、`requestHash`はEnvelope／projection／message markerを介してproviderへ保存する。

初期v2でDBレスの操作回復を成立させる最低条件を次とする。

- thread作成時の最初のprovider writeへ、`threadId`、`intentId`、`requestHash`を同じ操作で保存する。
- Feedback Service再起動後も、Connectorはprovider上の検索だけで`threadId`からprovider objectを一意に解決できること。
- reply／revisionでは、providerが本文とintent markerを同じwriteで保存できる場合に限り`recoverable`とする。
- response timeout等で結果が不明な間は`pending`とし、不存在を安全に証明できない限り同じ操作を自動再作成しない。
- 上記を満たせない操作は`best-effort`として明示し、結果不明時は`repair_required`または利用者による確認を要求する。

### 6.4 attachmentとstreaming

- JSON DTOは`AttachmentDescriptor`だけを持ち、`attachmentId`、表示名、media type、byte length、download可否を表現する。
- providerのattachment IDやURLはbrowserへ返さない。
- uploadはJSON command partとbinary partからなる`multipart/form-data`とし、base64埋め込みを行わない。
- `UploadAttachmentCommand`は`attachmentId`、`intentId`、関連付け先thread／message、filename、media type、byte length、用途を持つ。
- server portはupload metadataとbackpressure対応stream sourceを分離し、消費済みrequest bodyの自動再送を要求しない。
- downloadはgateway経由のstreamとし、全bodyのmemory bufferingをport契約で要求しない。
- server portはmetadataとstream sourceを分離し、backpressureと`AbortSignal`を伝播する。
- byte上限、許可media type、filename正規化、content disposition、timeoutをwire契約へ含める。
- range requestはcapabilityで表現し、未対応providerへ共通必須要件として課さない。
- response送信開始後は自動retryしない。開始前のretryだけを共通規約の対象にする。

初期v2ではattachment uploadのexactly-onceを共通保証としない。

- Connectorが同じ`attachmentId`または`intentId`からprovider attachmentを一意に発見できる場合だけ、upload結果を`recovered`として返す。
- upload成功後にresponseが失われ、既存attachmentを一意に確認できない場合は`repair_required`とする。
- controllerとgatewayは結果不明なbinary bodyを自動再送しない。
- 利用者が明示的に再送する場合も同じ`intentId`を使用し、重複の可能性をUIで通知する。

### 6.5 error、HTTP status、retry

`FeedbackProblem`は少なくとも次を持つ。

```text
type / title / status / code / detail / traceId
retryable / retryAfterSeconds?
conflict?
```

- validationは400または422、未認証は401、grant／profile policy／remote authorizationの許可不足は403、非存在は404とする。
- optimistic conflictと既存intentのrequest hash不一致は409とする。
- size超過は413、media type不正は415、rate limitは429とする。
- provider障害は502、availability／timeoutは503／504へ正規化する。
- `Retry-After` headerと`retryAfterSeconds`が両方ある場合は同値にする。
- retryableでない4xxをcontrollerが自動retryしない。
- provider response本文、secret、credentialをproblemやlogへ含めない。

### 6.5.1 検索projectionの扱い

検索projectionは候補objectを発見するためだけに使用し、正本または認可判断の入力として使用しない。

Connector／gatewayは検索hitをbrowserへ返す前に、対応するEnvelopeまたはmarkerについて次を検証する。

- 署名とschema version
- `providerBinding`と実際のprovider objectの一致
- requestの`profileId`、`workspaceId`、resource scopeとの一致
- 現在のAuthorization Mode、server profile policy、backend capability

検証に失敗したrecordを検索projectionだけに基づいて返さない。

### 6.6 server内部参照とbrowser DTOの分離

server／Connector内部だけで次を扱う。

```ts
type ProviderRef = {
  providerKey: string;
  objectId: string;
  eventId?: string;
  canonicalUrl?: string;
};
```

browser wire契約は`threadId`、`messageId`、`eventId`、`attachmentId`等のFeedback stable IDだけを返す。外部画面へ移動できる場合も、provider URLではなく認可付きsame-origin navigation pathを返す。`ProviderRef`をOpenAPI componentやbrowser packageからexportしない。

### 6.7 stable ID、ordering、未読

- 新規`threadId`、`intentId`、`messageId`、`eventId`、`attachmentId`はprovider write前に生成する。
- Envelope／markerへstable IDを保存し、readerごとに再採番しない。
- legacy recordは`profileId`、provider object ID、provider event ID、event kindから決定的IDを生成する。配列indexや表示順をseedにしない。
- event ordering keyは`occurredAt`と`eventId`の組とする。同一timestampでは`eventId`で順序を固定する。
- unread対象は初回message、reply、revision eventとする。attachment metadataの再取得だけではunreadにしない。
- ClientStateV2はthreadごとの最後に閲覧したordering keyを保存し、それより後のeventをunreadとする。
- pagination、polling、legacy readerのすべてが同じordering fixtureを通過する。

### 6.8 `FeedbackRepositoryPort`

server portは次の責務を持つ。

- profileとcapabilityの取得
- thread一覧と詳細の取得
- thread作成
- message追加
- revision追加
- attachment uploadとmetadata／stream取得
- intent IDによる作成・返信・revision・attachment upload結果の回収

provider固有DTO、HTTP client、field ID、URLはportの外側へ出さない。provider固有制約はcapability、creation field、正規化errorで表現する。

### 6.9 `FeedbackClientPort`

browser portはv2 wire意味論を保ちつつ、HTTP実装をcontrollerから隠蔽する。

- profile、一覧、詳細、pagination
- create、reply、revision、intent回収
- attachment upload／download
- operationごとの`AbortSignal`
- `FeedbackProblem`の保持

HTTP statusをrendererへ直接分岐させず、portで型付き結果／problemへ変換する。

### 6.10 controller snapshot／command契約

contract-only package entry pointとgolden snapshot fixtureを、Overlay抽出より先に作る。

snapshotは少なくとも次を表現する。

- lifecycle、profile、capability、effective permission
- resource／workspace queryとpage状態
- 選択thread、loading、refresh、error
- draft、follow、unread ordering key
- pending intentとrecovery状態
- target selectionとcapture状態
- navigation requestとplugin lifecycle

commandは少なくとも次を表現する。

- connect／refresh／load more／select thread
- follow／unfollow／update draft
- begin／cancel target selection
- begin／cancel evidence capture
- submit／reply／revise／recover intent
- request navigation／acknowledge navigation
- disconnect／destroy

ReactとWeb Componentは同じcommandを発行し、同じgolden snapshotを描画入力として使用する。

## 7. Envelopeと鍵lifecycle

Envelope codecやRedmine dual-writeより先に、ADRとtest vectorで次を固定する。

### 7.1 canonicalizationと署名対象

- canonical JSONはRFC 8785 JSON Canonicalization Schemeに固定する。
- UTF-8でencodeし、`signature` fieldを除いたEnvelope payloadを署名する。
- 署名入力にはschema versionと用途を示すdomain separatorを付ける。
- Envelopeは`profileId`、provider installationのstable ID、Connectorが不変と定義するprovider object identityを`providerBinding`に持ち、すべてを署名対象に含める。
- message markerは親threadの`providerBinding`を署名対象に含め、別ticket／profile／installationへのコピーを拒否する。
- Envelope、message marker、participant credentialでdomain separatorを共有しない。
- schema、canonical bytes、署名値、改ざん例をtest vectorとしてversion管理する。

### 7.2 key ringと分離

次の鍵を分離する。

1. Envelope／message marker署名key ring
2. participant credential署名key ring
3. participant ID導出鍵

- key ringは一つのactive signing keyと複数のverify-only keyを持つ。
- credential旧鍵は最大credential寿命とclock skewを超えるまで検証用に残す。
- providerに永続化したEnvelope／markerの旧鍵は、再署名移行が完了するまで検証用に残す。
- participant ID導出鍵をcredential署名鍵のrotationへ連動させない。
- participant ID導出鍵の変更は通常rotationではなくidentity migrationとして扱い、旧ID aliasと自己編集互換を先に実装する。
- `kid`は鍵materialから暗黙導出せず、設定で一意に管理する。
- secretに既定値を設けず、起動時にactive key、重複`kid`、鍵長を検証する。

### 7.3 unknown `kid`と改ざん

- `kid`が不明、署名不正、canonicalization不能なv2 Envelopeはintegrity errorとし、v2 metadataとして使用しない。
- 署名が正常でも`providerBinding`が実際のprofile／installation／objectと一致しない場合はintegrity errorとする。
- 同じ`threadId`／`intentId`のvalid Envelopeが複数objectに存在する場合は`repair_required`とし、自動で一つを選ばない。
- v2 Envelopeが存在するのに署名検証だけ失敗した場合、legacy markerへ黙ってfallbackしない。
- v2 Envelopeが存在しないlegacy ticketだけをlegacy readerの対象にする。
- key取得障害とunknown `kid`を区別してlog／metric化するが、browserへ内部情報を返さない。

## 8. v1／v2移行契約

### 8.1 reader優先順位とevent merge

thread metadataは次の順で解決する。

1. 正常に検証できたv2 Envelopeとprojection
2. v2 Envelopeが存在しない場合だけv1 marker／custom field
3. どちらもないticketはFeedback対象外

event streamはvalidなv2 eventとlegacy-only eventをstable `eventId`でmergeする。両形式が同じeventを表す場合はv2表現を優先し、v1 clientがdual-write ticketへ後から追加したlegacy eventは捨てない。表現の対応付け、deduplicate、orderingはcompatibility fixtureで固定する。

v2とlegacyのthread metadataが矛盾する場合はv2を正本とし、compatibility warningを記録する。v2 Envelopeまたはv2 event markerの署名が不正な場合はintegrity errorとし、そのrecordをlegacy値で上書きしない。

### 8.2 dual-write順序と回復

- browserで`threadId`と`intentId`を先に生成する。
- 最初にv1で読めるticket／messageを作り、provider object IDを確保する。
- 次にv2 Envelopeと検索projectionを書き、最後にattachmentを関連付ける。
- 各段階を同じ`intentId`で再検索できるようにし、再実行は不足artifactだけを補う。
- 途中失敗は`repair_required`または回収可能な`pending`として返し、新しいticketを作らない。
- v2停止／rollback時も、作成済みのv1-compatible部分をv1 readerが読める状態を保つ。

### 8.3 compatibility matrix

| 状態／操作 | v1 reader | v2 reader | write／回復規約 |
| --- | --- | --- | --- |
| v1-only ticket | 現行どおり読む | legacy readerでv2 modelへ写像する | 初回v2 write時も既存IDを維持する |
| v2 dual-write ticketのread | legacy部分を読む | v2 metadataとlegacy-only eventをmergeする | stable IDで重複排除する |
| v1からdual-write ticketへreply／revision | 現行どおり更新する | legacy-only eventとして取り込む | 次のv2 writeで既存eventを消さない |
| v2からdual-write ticketへreply／revision | v1 markerを読む | v2 eventを優先して読む | 同じintentで両形式を対応付ける |
| ticket作成後、Envelope前に失敗 | ticketを読める | intent検索でincompleteを検出する | Envelope／projectionだけを補修する |
| Envelope後、projection前に失敗 | legacy部分を読める | object IDからEnvelopeを読める | projectionだけを補修する |
| projection後、attachment前に失敗 | attachmentなしで読める | `pending`または`repair_required` | attachmentだけを再送する |
| legacyとvalid v2が共存 | legacyを読む | v2を優先する | 差異をwarningとして計測する |
| legacyとinvalid v2が共存 | legacy単独利用は継続可能 | integrity error | 自動fallback／上書きをしない |
| v2停止／rollback | standalone v1で継続可能 | 停止 | v2保存形式migrationをv1必須にしない |

### 8.4 v1 facadeのsecurity boundary

- Feedback Service内のv1 facadeとv2はserver profileに固定した同じAuthorization Modeを通す。
- legacy standalone reference serverの公開participant modeは、v2 `public-profile`と同じ認可意味論として維持する。
- `signed-grant`／`remote-authorization` profileと`public-profile`を同じprofile IDやpathへ同時mountしない。
- request parameter、header、pathによるAuthorization Modeのfallbackを許さない。
- v1の互換保証対象、廃止条件、告知期間を`docs/api-compatibility.md`へ記録する。

## 9. 実装Phaseとhard gate

### Phase 0: ADRと現行挙動の固定

#### 作業

- [x] 本設計文書と実装計画をversion管理対象として追加する。
- [x] DBレス実行トポロジ、Authorization Mode、signed grant claims、Jira Cloud先行をADRへ記録する。
- [x] Envelope canonicalization、署名対象、key ring、identity鍵分離をADRとtest vectorへ記録する。
- [x] 型の正本、互換期間、v1／v2 security boundaryをADRへ記録する。
- [x] 現行v1のprofile、一覧、詳細、投稿、返信、自己編集、添付取得をcharacterization testで固定する。
- [x] UIのfollow、unread、pending intent、capture cancellation、navigationをcharacterization testで固定する。
- [x] pluginのmount、再mount、unmount、破棄後callback禁止をcharacterization testで固定する。
- [x] current package export、localStorage／sessionStorage key、runtime configを互換台帳へ追加する。
- [x] 現行公開participant modeの意味論を`public-profile`のcharacterization testとして固定する。
- [x] `bash scripts/verify-feedback.sh`をskip変数なしで実行し、移行開始時点の結果を記録する。

#### Hard gate 0

- ADRに未決欄がない。
- v1とUIの主要挙動が自動testまたは明示的な未検証項目として記録されている。
- 初期Jira対象がCloudへ固定されている。
- Feedback ServiceがDB、queue、persistent／shared application data cache、upload directory、private object storageを必要としないトポロジが固定されている。
- 3つのAuthorization Modeの信頼境界、失効上限、fail-closed規約が固定されている。
- baselineの正規検証結果が記録され、失敗／未検証を成功扱いしていない。

### Phase 1: 契約draftと全package skeleton

#### 作業

- [x] 単一integration ownerが全package directory、package名、依存DAG、空の公開entry pointを追加する。
- [x] 同じownerがroot `package.json`、lockfile、build／test／verify／release scriptを更新する。
- [x] 汎用OpenAPIとdomain／Envelope schema draftを追加する。
- [x] 6章のquery、command、result、page、cursor、problem、attachment契約を定義する。
- [x] server内部`ProviderRef`とbrowser DTOを別moduleに置き、依存禁止testを追加する。
- [x] `FeedbackRepositoryPort`と`FeedbackClientPort`のcontract-only実装を追加する。
- [x] `AuthorizationGrant`、`AuthorizationDecision`、`FeedbackAuthorizationPort`のcontract-only実装を追加する。
- [x] provider profile schema、secret reference、mode固定規約とfake profile loaderを追加する。
- [x] controller snapshot／command契約とgolden fixtureを追加する。
- [x] stable ID、ordering、unread fixtureを追加する。
- [x] OpenAPIとJSON SchemaからTypeScript型を生成し、drift検査を追加する。
- [x] `docs/api-compatibility.md`とCHANGELOGを更新する。

#### Hard gate 1

- 全consumerが参照する型の正本が一つに決まっている。
- package DAGに循環がなく、generic packageへRedmine、Jira、React、DOM依存が入っていない。
- root共有ファイルを並列laneが編集しなくてよい状態になっている。
- contract-only buildとgolden fixture testが成功する。

### Phase 2: fixture、TCK、codec、Jira contract spike

#### 作業

- [x] fake `FeedbackRepositoryPort`とfake `FeedbackClientPort`を作成する。
- [x] 3つのAuthorization Modeのfake、共通decision fixture、profile固定／fallback禁止testを作成する。
- [x] Connector conformance test kitを作成する。
- [x] Envelope codecをADR test vectorどおりに実装する。
- [x] Redmine v1／v2 fixtureを作成する。
- [x] Jira Cloud fixtureによるcontract spikeを行う。本番ConnectorやUIはまだ作らない。
- [x] Jiraのissue／comment／property往復mappingを検証する。
- [x] 管理されたJira Cloud test tenantで、thread作成時の`threadId`／`intentId`保存、完全一致検索、comment marker、attachment upload、response timeout後の回収可否を確認する。
- [x] live確認で得たrequest／responseはcredentialとtenant情報を除去してfixture化し、確認日と対象API versionを記録する。
- [x] create／reply／revisionのintent保存と回収を検証する。
- [x] pagination、同一timestamp、stable orderingを検証する。
- [x] attachment upload／downloadと上限を検証する。
- [x] creation field、権限不足、unsupported capabilityの縮退を検証する。
- [x] Redmine／Jiraで表現できない契約を修正し、fixtureと生成型を同時更新する。

#### Contract freeze gate

- RedmineとJira Cloud fixtureが同じTCKの契約を満たす。
- query、command、result、conflict、intent回収、attachment、error、port、controller契約に未決事項がない。
- Authorization Mode、signed grant、remote authorization、provider profileの契約に未決事項がない。
- Envelope test vector、stable ordering、golden snapshotが固定されている。
- v1／v2 compatibility matrixの全行にtest計画がある。
- RedmineとJira Cloudについて、最初のprovider writeへ操作回復metadataを保存できることと、process再起動後に`threadId`／`intentId`をprovider上で再解決できることがlive環境で確認されている。
- create、reply、revision、attachment uploadの保証水準が`recoverable`、`best-effort`、`unsupported`のいずれかに決定されている。
- attachment uploadが`best-effort`の場合、結果不明時に自動再送しないcontroller契約が固定されている。
- freeze tag以降の破壊的変更は契約ownerの承認と全consumer影響確認を必須とする。

### Phase 3: freeze後の4実装lane

#### Lane A: Feedback Service／gateway

- [x] DB、queue、persistent／shared application data cache、upload directoryに依存しないFeedback Service skeletonを実装する。
- [x] read-only provider profile／secret loaderとmode固定検証を実装する。
- [x] 現行v1と同等の`public-profile`とparticipant credential所有確認を実装する。
- [x] OIDC／token exchange JWT validation、signed grant対象照合、短寿命規約を実装する。
- [x] remote authorization client、timeout、response validation、fail-closed規約を実装する。
- [x] fake Connectorを使ってgateway application serviceとv2 HTTP adapterを実装する。
- [x] same-origin、CSRF、request size、content type、timeout、IDOR対策を実装する。
- [x] server profileのAuthorization Modeに対応したv1 facadeを実装する。

#### Lane B: Redmine stacked PR

同一ownerが次をstacked PRとして順番に実装する。

1. Redmine mapperとprovider provisioning
2. legacy readerとstable ID復元
3. Envelope／projection writer
4. dual-writeと段階別intent回復
5. v1／v2 compatibility matrix test

このlaneを別ownerへ分割しない。既存Redmine client、marker、projection、handlerの同時編集を避ける。

上記5段階は同一laneで順に実装済みである。v2 custom field provisionerは既存v1 fieldを変更せず、plan digest確認後だけapplyする独立運用artifactとした。

#### Lane C: Jira Cloud Connector

- [x] spike fixtureをproduction mapper／clientへ置換する。
- [x] issue、comment、property、attachmentを実装する。
- [x] JQL等によるprojection検索とintent回収を実装する。
- [x] rate limit、pagination、権限不足、attachment上限を正規化する。
- [x] 管理環境のacceptance testを追加する。

Forge entity property indexはJira Connectorに付随する独立deploy artifactとして管理し、Feedback Serviceへ組み込まない。Phase 2の管理環境fixtureと同じmanifestを使用し、function、UI、Storage、Connect moduleを持たない。

#### Lane D: browser headless stack

- [x] generic HTTP transportを実装する。
- [x] ClientStateV2とlegacy storage readerを実装する。
- [x] golden snapshotに対するHeadless Controllerを実装する。
- [x] clock、scheduler、visibility、storage、ID生成、navigation、captureを注入可能にする。
- [x] follow、unread、pending intent、cancellation、plugin lifecycleをcharacterization testと照合する。

#### Lane完了条件

- [x] 各laneは自packageのscoped testを実行する。
- [x] fakeを使った境界testにより、他laneの未完成実装へ依存しない。
- [x] shared contract、root scripts、lockfileの最終変更をintegration ownerだけが行う。

Phase 3 Gateの証跡は`docs/phase3/phase3-gate.md`、fail-closed検証入口は`scripts/check-feedback-phase3.sh`とする。Gate通過後はPhase 4へ進まず停止する。

### Phase 4: renderer並列実装

controller契約とgolden snapshotが実装済みになってから開始する。

#### React renderer

- [x] React Overlayをsnapshot購読とcommand発行だけへ縮小する。
- [x] 既存Redmine React packageを互換wrapperへ移行する。
- [x] 現行UI characterizationを通す。

#### Web Component

- [x] Shadow DOMを使う標準Web Componentを追加する。
- [x] framework非依存pluginでcontrollerの生成、接続、破棄を扱う。
- [x] keyboard、focus、ARIA、CSP、style隔離を検証する。
- [x] vanilla appのbrowser E2Eを追加する。

ReactとWeb Componentは並列化できるが、controller contractを各renderer都合で変更しない。

#### Phase 4 Gate

- [x] Phase 2のcontract freeze、controller contract、golden snapshotのchecksumが一致する。
- [x] React rendererはcontroller snapshot購読とcommand発行以外のtransport／storage／pollingを持たない。
- [x] 標準Web Componentとframework非依存pluginはReact／provider runtimeへ依存しない。
- [x] 既存Redmine UI characterization、renderer scoped test、vanilla実Chrome E2Eが成功する。
- [x] strict CSP、Shadow DOM style隔離、keyboard／focus／ARIA、destroy後callback禁止を検証する。

Phase 4 Gateの証跡は`docs/phase4/phase4-gate.md`、fail-closed検証入口は`scripts/check-feedback-phase4.sh`とする。Gate通過後はPhase 5へ進まず停止する。

### Phase 5: 統合、cutover、release

- [x] Feedback ServiceとRedmine／Jira Connectorを統合する。
- [x] v1／v2 compatibility matrixを実環境相当で全行実行する。
- [x] partial write、timeout、rollback、unknown `kid`、旧鍵検証をfault injectionで検証する。
- [x] React／Web Componentから同じprovider acceptance suiteを実行する。
- [x] deployment、保存形式migration、key rotation、incident、rollback文書を追加する。
- [x] 各設定追加PRで`docs/environment-variables.md`を同時更新し、Phase 5ではprovider profile schema、実装、運用文書間の最終drift検査を行う。
- [x] integration ownerがclean workspaceで`bash scripts/verify-feedback.sh`をskipなしで直列実行する。
- [x] release前監査で判明したwire不一致をalpha.2で訂正し、intent回収hash header、public participant発行、unsafe requestのCSRF header、`resource.key`上限をOpenAPI／生成型／client／Serviceで統一する。
- [x] Jira／Redmineの署名本文、revision chain、attachmentのmessage／content hash bindingを検証し、改変または未知messageをfail-closedにする。
- [x] 標準React／Web ComponentからID／request hash生成済みのsubmit、reply、revise、capture-to-uploadを実行し、結果不明時は回収だけを提示する。
- [x] readinessでkey ring、導出鍵、provider credentialの形式を解析し、不正設定をHTTP 503とする。
- [x] actual HTTP client、Feedback Service、Gateway、production projection verifier、Jira Connectorを通るin-process acceptanceと、現source digestへ束縛した明示Jira Cloud live Gateを追加する。

### 後続Connector追加計画

後続Connectorはproviderごとに独立した多数のPhaseへ分割せず、次の二段階で追加する。最初にBacklogへこの手順を適用し、既存の汎用層を優先して利用する。BacklogのStage AがHard Gateを通過したら、そのままStage Bへ進める。Jira Data Centerは案件・利用要望が発生するまで着手せず、発生時もStage Aを省略しない。

#### Stage A: DBレスcontract applicability spike／Hard Gate

- 既存v2契約とConnector TCKを変更せずに適用し、provider APIの事実をfixtureへ記録する。
- Feedback本文、会話、revision、証跡、attachment metadata、操作回復metadataをproviderだけへ保存し、Feedback Service再起動後にローカル状態なしで一意に再解決できることを確認する。
- 最初のthread writeへ本文と`threadId`、`intentId`、`requestHash`を同時に保存できることを確認する。後続writeまたは補助DBが必要ならDBレスcreate要件は不成立とする。
- create、reply、revision、attachment uploadごとに、同一writeへのmarker保存、provider検索、結果不明時の安全な回収可否を確認し、保証水準を決定する。
- Authorization Modeは既存三方式から選び、provider credentialはserver-side secretだけから解決する。membership、認可decision、操作状態をFeedback Serviceへ保存しない。
- Redmine／Jira Cloud／対象providerのmappingを比較し、既存共通部品で処理できる範囲と、共通層へ抽出すべきprovider非依存処理を確定する。
- Hard Gateを満たせない操作は`best-effort`または`unsupported`とし、DBやprovider外storageによる穴埋めを設計案へ含めない。

Stage Aの成果物は、provider事実fixture、capability／保証水準表、既存共通部品の再利用表、Connector固有実装の最小一覧とする。実装packageはこのGate通過前に作らない。

#### Stage B: 共通基盤拡張＋thin Connector実装／Conformance Gate

Backlogへ適用する実装境界は次に固定する。他の後続Connectorも同じ分類を使用する。

| 分類 | 配置 | 内容 |
|---|---|---|
| そのまま再利用 | `contracts/feedback`、`feedback-envelope`、`feedback-gateway`、`feedback-client`、`feedback-controller`、renderer | wire／domain DTO、署名、認可、操作回復結果、browser状態、UI |
| 共通拡張 | `feedback-connector-sdk`、runtime adapter registry、必要な共通server utility | 三provider以上で同じ意味を持つmetadata検証、回復判定、stream制御、error分類。Redmine／Jira Cloudも同じ実装へ移行する |
| Connector固有の最小実装 | `feedback-connector-backlog` | Backlog API transport、credentialのwire変換、Backlog DTO検証／mapping、Backlog検索構文、metadata保存位置、必要なprovisioning |
| 禁止 | Feedback Service、gateway、client、controller、renderer、補助storage | Backlog分岐、Backlog DTO、共通処理の再実装、DB／queue／永続cache／object storageによる機能補完 |

- Stage Aで必要性が確認できたprovider非依存処理だけを共通packageへ追加し、Redmine／Jira Cloudでも同じ実装を利用するregression testを先に追加する。
- runtimeは`connectorKey`、runtime profile検証、credential解決、`FeedbackRepositoryPort` factoryをserver-side adapter registryへ登録する。新provider追加のたびにcomposition、catalog、secret resolverへprovider分岐を増やさない。
- 対象Connector packageには、provider固有transport、DTO mapper、検索／metadata mapping、provisioningだけを実装する。Envelope、認可、操作回復state machine、browser state、rendererを再実装しない。
- 既存の共通Connector TCK、fault fixture、署名改ざん、0件／複数件検索、partial write、stream上限の検証を、新旧すべてのConnectorへ同じ期待値で適用する。
- Conformance Gateでは、generic packageへのprovider DTO／secret／URL／内部ID漏出がないこと、provider分岐と共通処理の複製が増えていないこと、Feedback ServiceがDBレスのままであることをfail-closedに検査する。
- Connector追加PRは変更ファイルを上表のいずれかへ分類し、Connector固有packageへ置いた処理が共通層で成立しない理由を記録する。理由を示せない独自実装は受け入れない。

#### Backlog release candidate Gate

- [x] Stage A Hard GateとStage B live Conformanceの能力境界を維持し、公開契約を変更しない。
- [x] root、全workspace、内部workspace依存を`1.0.0-rc.1`へ揃える。
- [x] Backlog Connectorを含むFeedback Service runtimeをnonroot distrolessのmulti-architecture OCIとして生成する。
- [x] OCI digest、SBOM、HIGH／CRITICAL脆弱性report、checksum、provider live evidence bindingをrelease manifestへ記録する。
- [x] tag起点workflowへFeedback Service runtimeのartifact生成と独立GHCR公開を追加する。
- [x] release候補sourceでBacklog live Conformanceを再実行し、全run-owned issueのcleanupを確認する。
- [x] `bash scripts/verify-feedback.sh`をskipなしで完走する。

実公開、tag、push、deploymentはrelease candidate Gateに含めない。

## 10. 目標package構成と依存DAG

名称はPhase 0 ADRで確定し、Phase 1の単一PRで全skeletonを作成する。

```text
contracts/feedback
  ├─ v2 OpenAPI
  ├─ domain / Envelope schema
  └─ Redmine v1互換契約

packages/feedback-core
  ├─ domain primitive
  ├─ host adapter
  ├─ target resolver contract
  └─ evidence provider contract

packages/feedback-client
  ├─ FeedbackClientPort
  ├─ generic HTTP transport
  └─ wire problem mapping

packages/feedback-connector-sdk
  ├─ FeedbackRepositoryPort
  ├─ server-only ProviderRef
  ├─ capability / connector error
  └─ conformance test kit

packages/feedback-envelope
  ├─ canonical codec
  ├─ signature / key ring port
  └─ test vector

packages/feedback-gateway
  ├─ application service
  ├─ input / authorization orchestration
  ├─ provider-backed intent recovery orchestration
  └─ connector registry

apps/feedback-service
  ├─ v2 HTTP adapter
  ├─ public-profile / participant credential
  ├─ signed-grant / remote-authorization adapter
  └─ provider profile / secret loader

packages/feedback-controller
  ├─ snapshot / command contract
  ├─ ClientStateV2 / legacy reader
  ├─ state machine / polling / retry
  └─ submit / navigation / capture orchestration

packages/feedback-web-component
packages/feedback-react
packages/feedback-connector-redmine
packages/feedback-connector-jira-cloud
```

依存方向は次に限定する。

```text
renderer → controller → client → contracts/core
service HTTP → gateway → connector-sdk → contracts/core
connector → connector-sdk + envelope
feedback-service → gateway + authorization / profile adapters
```

`connector-sdk`からbrowser package、renderer、provider実装へ依存しない。既存の`@geibee/feedback-redmine-*` packageは互換wrapperまたはRedmine運用packageとして維持する。

## 11. 並列作業と共有ファイル規約

### 11.1 integration ownerの専有範囲

次のファイルはintegration ownerだけが編集する。

- root `package.json`
- `package-lock.json`
- `contracts/feedback/**`
- 共通CHANGELOG／互換性文書
- `scripts/verify-feedback.sh`とrelease script
- workspace／CI設定

package laneは自package、専用fixture、専用testだけを編集する。共有契約変更が必要な場合は差分案と失敗fixtureを契約ownerへ渡す。

### 11.2 検証の直列化

- 並列laneはpackage scoped build／testだけを実行する。
- 同一workspaceで`npm ci`、root build、正規verifyを同時実行しない。
- `bash scripts/verify-feedback.sh`はintegration ownerがclean install後に直列実行する。
- merge queueはlockfile、生成型、root scriptの更新を一つずつ取り込む。
- scoped testだけの成功をrepository全体の成功として報告しない。

### 11.3 subagent実行規約

- integration ownerを含めて4並列を基準とし、root／integration ownerがshared contract、root設定、統合判定を所有する。
- subagentはそれぞれ独立worktree／branchを使用し、同一working treeでindex、lockfile、生成型を共有しない。
- 各task packetにbase commit、先行gate、編集可能path、編集禁止path、受け入れfixture、scoped test command、成果物形式を必ず含める。
- subagentは他laneの差分をcommitせず、自分の許可pathだけを明示的にstageする。
- shared contractの不足を発見した場合は、contractそのものを変更せず、最小の失敗fixture、差分案、consumer影響をintegration ownerへ返す。
- repository全体の正規verify、生成型更新、lockfile更新、mergeはintegration ownerが直列実行する。

Phase 3の4並列では、root／integration ownerがLane Aを兼務し、3つのsubagentがLane B、C、Dを担当する。

- Lane Aは新規`packages/feedback-gateway/**`と`apps/feedback-service/**`を所有する。
- Lane Bは新規`packages/feedback-connector-redmine/**`を所有する。
- Lane Cは新規`packages/feedback-connector-jira-cloud/**`を所有する。
- Lane Dは新規`packages/feedback-client/**`と`packages/feedback-controller/**`を所有する。
- 既存`feedback-redmine-core`、`feedback-redmine-gateway`、`feedback-redmine-react`、`feedback-redmine-plugin`の接続変更は、各lane完了後の直列Integration PRで行う。
- lane実装中に新しい依存、環境変数、公開契約が必要になった場合、subagentは共有fileを直接変更せずintegration ownerへ差分案を返す。

## 12. 検証計画

`bash scripts/verify-feedback.sh`から次をfail-closedで実行する。

### 12.1 共通契約

- OpenAPI、JSON Schema、生成型のdrift検査
- v1／v2 contract test
- query／cursor fingerprint／stable ordering test
- golden controller snapshot test
- generic packageへのprovider、React、DOM依存混入検査
- API、生成型、互換性文書、CHANGELOGの同期検査
- Feedback Service packageへDB client、ORM、queue、persistent／shared application data cache、server-side upload storage依存が混入していないことの検査

### 12.2 Feedback Service security

- OIDC／token exchange JWTのissuer、audience、claim、expiry、JWKS failure
- `public-profile`が本人認証ではないこととprofile到達境界
- signed grantとrequestのprofile／workspace／resource／operation完全一致
- token最大寿命、期限切れ、別profile／workspaceへのgrant流用防止
- remote authorizationのauthentication、timeout、不正response、上流障害時fail-closed
- server profileごとのmode固定とfallback禁止
- profile／workspace／resource境界のIDOR
- same-origin、CSRF、request size、content type
- secret、credential、provider responseのlog非露出
- v1 facadeによるAuthorization Mode迂回禁止
- processがDB、queue、persistent／shared application data cache、upload directory、private object storageを使用しないこと

### 12.3 Envelope／credential

- canonical JSON test vector
- Envelopeとmessage markerの改ざん
- valid Envelope／message markerの別object・別profile・別installationへのreplay
- 同一`threadId`／`intentId`の複数hitと`repair_required`
- key ring rotation、旧鍵検証、unknown `kid`
- participant署名鍵rotation後もparticipant IDが変わらないこと
- identity migration時の旧投稿自己編集互換

### 12.4 Connector conformance

- profile、capability、creation field
- resource／workspace一覧
- pagination、stable ordering、cursor
- thread作成とintent回収
- message／revisionとconflict
- attachment upload／download streaming、cancel、上限、partial write回復
- provider error正規化
- unsupported capabilityの安全な縮退
- rate limitとretryable判定
- partial write repair

### 12.5 Controller／renderer

- 状態遷移unit test
- pending intent再送／回収
- draft／follow／unread migration
- target selectionとcapture cancellation
- stale async resultのcommit禁止
- host navigation
- plugin mount／unmount／destroy lifecycle
- React互換test
- Web Component browser E2E
- accessibilityとstrict CSP

### 12.6 Provider別検証

- Redmineの既存version matrix
- Jira Cloud fixtureと管理環境acceptance test
- Backlogを最初の後続providerとするfixture、管理環境acceptance test、capability／保証水準表
- Jira Data Centerは案件・利用要望がある場合だけ、対象versionを固定したcloud／self-hosted compatibility matrix

## 13. Releaseと互換性

- v1 Redmine APIは移行期間中維持する。
- v2公開契約はContract freeze gateまでdraftとし、freeze後にalphaを開始する。
- alphaはconsumerの作り直しを許容する理由に使わず、freeze後の互換規則を適用する。
- 必須field追加、field削除、型変更、意味変更は新majorで扱う。
- v1 facade廃止には利用状況、移行文書、代替package、告知期間を必要とする。
- 保存形式変更ではlegacy readerを先に追加し、writer切替後も旧形式を読む。
- runtime configへsecretやprovider内部IDを追加しない。
- secretには既定値を実装しない。

## 14. 主なリスクと対策

| リスク | 対策 |
| --- | --- |
| 最初のmodelがRedmineへ過適合する | Jira Cloud fixture spikeを契約freeze前に行う |
| agentごとに補助型や意味論が分岐する | wire、server port、browser port、controller契約を正本化してから並列化する |
| Authorization Modeごとに認可意味論が分岐する | 共通`FeedbackAuthorizationPort`、mode固定、共通decision fixtureをfreezeする |
| `public-profile`が実在人物の認証と誤解される | profile到達境界とparticipant credentialの責務をOpenAPI・運用文書・UIで明示する |
| signed grant失効が遅れる | token最大寿命をADRで固定し、即時失効要件は`remote-authorization`を使用する |
| providerごとに検索能力が異なる | Envelopeとprojectionを分離し、冪等性水準をcapability化する |
| partial writeで重複ticketができる | 段階別intent回復とcompatibility matrixをTCKへ含める |
| 鍵rotationでparticipant IDが変わる | ID導出鍵を署名key ringから分離し、identity変更をmigration扱いにする |
| v1がv2認可の迂回路になる | v1／v2を同じprofile固定modeへ接続し、path／headerでのfallbackを禁止する |
| Controller抽出後にrendererが作り直しになる | contract-only snapshot／commandとgolden fixtureを先にfreezeする |
| 共有ファイル競合で並列性が落ちる | skeleton／DAG／lockfileを単一ownerが先行し、laneをpackage境界に限定する |
| 同一workspaceの正規verifyが競合する | integration ownerだけがclean workspaceで直列実行する |

## 15. 推奨PR stack

### Freeze前。調査／fixtureは並列、共有契約統合は直列

#### Wave 0: 現行挙動と制約の固定

1. root／integration owner: ADR、DBレスtopology、Authorization Mode、baseline verify
2. subagent A: v1 gateway／Redmine characterizationとfixture候補
3. subagent B: UI／plugin characterizationとcontroller golden候補
4. subagent C: Jira Cloud API制約、projection検索、intent回収の反例fixture

#### Integration 1: skeletonと契約draft

1. 全package skeleton、依存DAG、root scripts、lockfile、generic品質gate
2. 汎用OpenAPI／schema、生成型、wire意味論
3. `FeedbackRepositoryPort`、`FeedbackClientPort`、authorization／provider profile契約、controller契約

#### Wave 1: draftに対する並列検証

1. root／integration owner: Envelope codec、TCK core、shared contract判定
2. subagent A: Redmine v1／v2 fixtureとcompatibility反例
3. subagent B: fake client、ClientState／controller golden fixture
4. subagent C: Jira Cloud contract spikeとprovider制約fixture

#### Integration 2: freeze

1. 失敗fixtureから契約を修正し、OpenAPI、schema、生成型、TCKを同時更新
2. Redmine／Jiraの共通TCK、authorization fixture、controller goldenを直列検証
3. contract freeze tag／compatibility baseline

### Freeze後。4 laneで並列

1. stateless Feedback Service + Authorization Adapter + profile／secret loader + gateway application service
2. Redmine mapper → legacy reader → Envelope／projection → dual-writeの同一owner stack
3. Jira Cloud Connector
4. transport → ClientStateV2 → Headless Controllerの同一owner stack

### Controller実装後。並列

1. React rendererと既存React wrapper
2. Web Componentとframework非依存plugin

### 最終統合。直列

1. v1／v2統合とcompatibility matrix
2. browser E2Eとprovider acceptance
3. deployment／保存形式migration／rollback／release文書
4. clean環境での正規`bash scripts/verify-feedback.sh`

各PRは担当packageのscoped testを通す。APIまたはDTOを変更したPRは、OpenAPI、生成型、互換性文書、CHANGELOG、contract testを契約ownerの同一PRへ含める。

## 16. Milestone完了判定

### Milestone A: 契約freeze

- RedmineとJira Cloud fixtureが同じwire／port／TCK契約を満たす。
- Envelope、鍵lifecycle、stable ID、unread、controller snapshotに未決事項がない。
- Authorization Mode、provider profile、DBレス実行トポロジに未決事項がない。
- package skeletonと依存DAGが固定され、4 laneが共有ファイルを編集せず開始できる。

### Milestone B: Backend汎用化

- Feedback ServiceがDB、queue、persistent／shared application data cache、upload directory、private object storageなしで起動し、requestを処理できる。
- `public-profile`、`signed-grant`、`remote-authorization`が共通認可契約で動作し、mode fallbackがない。
- Redmineを`FeedbackRepositoryPort`経由で利用できる。
- `/internal/feedback/v2`から既存Redmine threadを操作できる。
- v1 facadeに認可迂回とregressionがない。

### Milestone C: UI汎用化

- Headless ControllerがReactとDOMに依存しない。
- Web ComponentをReact runtimeなしで利用できる。
- 既存React／Redmine pluginの互換経路がある。

### Milestone D: Provider汎用化

- profile切替だけでRedmineとJira Cloudを選択できる。
- UI、controller、gateway application serviceにprovider分岐がない。
- 両Connectorが同じconformance testを通過する。

### 汎用化完了条件

- RedmineとJira Cloudの双方で投稿、一覧、詳細、返信、revision、attachment、冪等性回復が動作する。
- provider固有機能差がcapabilityとcreation fieldだけで表現される。
- browser公開契約とgeneric packageへprovider secret、URL、内部ID、固有DTOが漏れていない。
- Feedback Serviceが実行時にDB、queue、persistent／shared application data cache、upload directory、private object storageを必要としない。
- v1／v2 compatibility matrix、partial write、rollback、key rotationが自動検証されている。
- `bash scripts/verify-feedback.sh`がすべての必須検証を実行し、成功している。

## 2026-09-07: DBレス参照拡張（alpha.3）

利用者判断により、重複排除はbest-effortとする。[共通参照規約](contracts/feedback/thread-reference.md)と[ADR 0005](docs/adr/0005-protected-thread-reference.md)が、本文のprovider検索による全体的一意性を必須とする規約を更新する。可視の複数候補を拒否する規約は維持するが、検索1件を全体的一意性の証明とはしない。

参照取得後は認証付き暗号化tokenにより同じticketへ直接アクセスする。初回writeのthreadId／intentId／requestHash同時保存、操作ごとのrecoverable／best-effort、projection検証、attachment upload独立権限は維持する。参照は権限・exactly-once・offline read・端末間同期を追加しない。Redmine v1は変更しない。鍵未設定profileは従来動作を維持し、有効化には独立secretとlive再検証が必要である。
