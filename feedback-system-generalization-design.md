# 汎用フィードバック基盤への再設計方針

対象リポジトリ: `https://github.com/geibee/feedback-system`

## 1. 目的

現状のフィードバック基盤は、React SPAへフィードバックUIを埋め込み、投稿・返信・スクリーンショット等をRedmineへ保存する構成になっている。

今後は以下を目指す。

- Redmineへの依存をなくす
- Reactへの依存をなくす
- Jira、Azure DevOps、GitLab、GitHub Issues等へ保存先を交換可能にする
- Feedback Serviceは専用DB、queue、persistent／shared application data cache、upload directory、オブジェクトストレージを持たない
- フィードバックの正本はチケット管理システム側へ置く
- gatewayはステートレスな薄い層として維持する
- UI、ホストアプリ、チケット管理システムの依存を分離する

---

## 2. 現状設計の評価

現状でも以下の点は良い。

- `feedback-core` はReact、DOM、MapLibre、特定routerに依存していない
- `FeedbackHostAdapter` によりホストアプリとの境界がある
- スクリーンショットは `Uint8Array` ベースで抽象化されている
- Redmineを正本として利用し、専用DBやobject storageを持たない
- thread ID、intent ID、request hash等を使った冪等性回復の仕組みがある
- participant credentialを署名付き自己完結トークンとして扱っている
- draft、follow、未読等はlocalStorage / sessionStorageへ置き、サーバー側状態を増やしていない

一方で、以下の依存が強い。

- 公開契約が `redmine-gateway.openapi.yaml` 由来の型に依存している
- `issueId`、`journalId`、`tracker`、`redmineUrl` 等のRedmine概念が中核モデルへ露出している
- `redmine.*` のエラーコードが公開契約へ露出している
- gateway handlerがRedmine clientを直接生成している
- priority、parent issue等のRedmine固有ロジックがgatewayにある
- Reactコンポーネントに状態管理・業務ロジック・API呼び出し・画面遷移・スクリーンショット処理が集中している
- 標準pluginが内部でReact Rootをmountするため、vanillaアプリでもReact runtimeが必要

したがって、全面再構築ではなく、**既存の良い抽象を残しつつRedmine層・React層へ漏れている責務を中核へ戻すリファクタリング**が適切。

---

## 3. 推奨アーキテクチャ

```text
業務アプリ
 ├─ FeedbackHostAdapter
 ├─ TargetResolver
 ├─ EvidenceProvider
 ├─ FeedbackController
 └─ Renderer
      ├─ Web Component
      ├─ React
      ├─ Vue / Svelte 等
      └─ Host独自UI
            │
            ▼
Feedback Service
 ├─ Authorization Adapter
 │    ├─ public-profile
 │    ├─ signed-grant（OIDC / token exchange JWT）
 │    └─ remote-authorization
 ├─ read-only Provider Profile / Secret Loader
 └─ 汎用Gateway Application Service
      ├─ CSRF対策
      ├─ participant credential
      ├─ 入力検証
      ├─ 冪等性制御
      ├─ capability制御
      └─ FeedbackRepositoryPort
      ├─ RedmineConnector
      ├─ JiraCloudConnector
      ├─ AzureDevOpsConnector
      ├─ GitLabConnector
      ├─ GitHubConnector
      ├─ BacklogConnector
      └─ その他
            │
            ▼
チケット管理システム
 ├─ ticket / issue / work item = Feedback Thread
 ├─ comment / note / journal   = Message / Event
 ├─ attachment                 = screenshot / context
 └─ custom field / property    = 検索用projection
```

ポイントは、RedmineやJira等を単なるREST clientとして扱うのではなく、**Feedbackの意味論をチケット管理製品へ写像するConnector**として扱うこと。

---

## 4. 中核契約のRedmine非依存化

### 4.1 provider参照とbrowser DTOを分離する

現状の数値ID前提をやめる。ただし、opaqueな文字列に変えるだけでprovider IDやURLをbrowserへ公開してはならない。

server／Connector内部だけで次を扱う。

```ts
type ProviderRef = {
  providerKey: string;
  objectId: string;
  eventId?: string;
  canonicalUrl?: string;
};
```

browserへ返すthreadはFeedback基盤のstable IDだけを持つ。

```ts
type FeedbackThread = {
  threadId: string;
  subject: string;
  state: "open" | "closed";
  messages: FeedbackMessage[];
  attachments: FeedbackAttachment[];
  location: FeedbackLocation | null;
  target: FeedbackTarget | null;
  externalNavigationPath?: string;
};
```

`externalNavigationPath`は認可付きsame-origin endpointとし、provider URLを直接返さない。provider固有fieldはserver内部のmapper入力に限定し、browser DTOの拡張fieldとして公開しない。

主な置換:

- `issueId` → server内部`ProviderRef.objectId`、browserでは`threadId`
- `redmineUrl` → server内部`ProviderRef.canonicalUrl`、browserではsame-origin navigation path
- `journalId` → server内部`ProviderRef.eventId`、browserではstableな`eventId`
- `redmine.*` → `feedback.*` / `backend.*`
- 数値型assignee / priority ID → Connector内部のopaque stringと宣言的creation field

---

## 5. FeedbackRepositoryPort

gatewayから各製品固有APIを直接触らず、以下のようなportへ依存させる。

```ts
interface FeedbackRepositoryPort {
  getProfile(query: GetProfileQuery, signal?: AbortSignal): Promise<FeedbackProfile>;
  listThreads(query: ListThreadsQuery, signal?: AbortSignal): Promise<Page<FeedbackThreadSummary>>;
  getThread(query: GetThreadQuery, signal?: AbortSignal): Promise<RepositoryThread>;
  createThread(command: CreateThreadCommand, signal?: AbortSignal): Promise<CommandResult>;
  appendMessage(command: ReplyCommand, signal?: AbortSignal): Promise<CommandResult>;
  appendRevision(command: AppendRevisionCommand, signal?: AbortSignal): Promise<CommandResult>;
  uploadAttachment(
    command: UploadAttachmentCommand,
    source: AttachmentUploadSource,
    signal?: AbortSignal
  ): Promise<CommandResult>;
  recoverIntent(query: RecoverIntentQuery, signal?: AbortSignal): Promise<IntentRecoveryResult>;
  getAttachment(query: GetAttachmentQuery, signal?: AbortSignal): Promise<AttachmentStream>;
}
```

`RepositoryThread`はserver内部`ProviderRef`を持てるが、HTTP DTOへ直接serializeしない。attachmentはmetadataとstreamを分離し、全bodyの`Uint8Array`化を共通要件にしない。`UploadAttachmentCommand`はstableな`attachmentId`と`intentId`を持ち、`AttachmentUploadSource`はbyte length、media type、filename、backpressure対応streamを提供する。gatewayは消費済みstreamを自動再送せず、再試行時はbrowserが同じIDで新しいbodyを送る。query、command、page、cursor、result、problemの正確な意味論は実装計画のContract freeze gateで固定する。

`createIssue()` や `addComment()` のような低水準CRUDを共通契約にすると、Redmine/Jira等の差異がgatewayへ逆流する。

そのため、Connectorは以下まで責任を持つ。

- Feedback Threadをticketへどう写像するか
- Message / Revisionをcommentやjournalへどう写像するか
- metadataをどこへ保存するか
- 検索用projectionをどう作るか
- 重複投稿をどう回収するか
- attachment upload／download、partial write、同一intentの回収をどう扱うか
- provider固有制約をどうcapabilityとして公開するか

---

## 6. チケット管理システムを正本にする方式

この方針は維持可能。

正本は以下の二層構造にする。

### 6.1 署名付きFeedback Envelope

完全な意味情報を保存する。

```json
{
  "schemaVersion": "2",
  "threadId": "...",
  "intentId": "...",
  "providerBinding": {
    "profileId": "...",
    "installationId": "...",
    "objectId": "..."
  },
  "scope": {
    "application": "...",
    "environment": "...",
    "workspace": "...",
    "resource": {
      "kind": "record",
      "key": "..."
    }
  },
  "location": {},
  "target": {},
  "release": "...",
  "perspective": "...",
  "createdBy": {
    "participantId": "..."
  },
  "createdAt": "...",
  "requestHash": "...",
  "signature": {
    "kid": "...",
    "value": "..."
  }
}
```

`providerBinding`はserver／Connector内部だけで使用し、browser DTOへserializeしない。`objectId`は表示keyではなく、Connectorがprovider内で不変と判定するobject identityとする。ticket作成後にobject identityを得てからEnvelopeへ署名し、正常なEnvelopeが別ticket、別profile、別provider installationへコピーされた場合もbinding mismatchで拒否する。

保存先候補:

- ticket本文のmachine-readable marker
- JSON attachment
- provider固有property

### 6.2 検索用projection

チケット管理システムの検索に使う最低限の値のみcustom field等へ持つ。

推奨:

```text
feedbackThreadId
feedbackIntentId
feedbackScopeHash
feedbackPageKey
feedbackPerspective
```

現行の11個程度のRedmine custom fieldを各製品へ一対一移植するより、検索キーを圧縮した方が移植性が高い。

### 6.3 canonicalizationと鍵lifecycle

Envelope実装前に次を固定する。

- RFC 8785によるcanonical JSON
- `signature`を除いたpayloadと用途別domain separatorを署名対象にすること
- `providerBinding`のprofile、installation、object identityを署名対象に含め、別objectへのreplayを検出すること
- active signing keyとverify-only旧鍵からなるkey ring
- Envelope／message marker鍵、participant credential鍵、participant ID導出鍵の分離
- 永続Envelopeの旧鍵を再署名移行まで保持する規約
- unknown `kid`や署名不正時にlegacy値へ黙ってfallbackしない規約

participant IDをcredential署名鍵から導出すると通常の鍵rotationでIDが変わる。ID導出鍵は署名key ringから分離し、その鍵の変更は旧ID aliasを伴うidentity migrationとして扱う。

---

## 7. React依存の除去

現状のReact Overlayには以下が集中している。

- thread一覧取得
- workspace一覧取得
- polling
- unread計算
- follow状態
- thread選択
- 画面遷移
- target選択
- screenshot取得
- draft
- pending intent
- 冪等再送
- submit
- JSX描画

これをHeadless Controllerへ移す。

```ts
interface FeedbackController {
  getSnapshot(): FeedbackSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  beginTargetSelection(): void;
  selectTarget(target: FeedbackTarget): Promise<void>;
  submit(command: SubmitFeedbackInput): Promise<void>;
  openThread(threadId: string): Promise<void>;
  reply(threadId: string, body: string): Promise<void>;
  revise(messageId: string, body: string): Promise<void>;
  destroy(): void;
}
```

Reactはsnapshotを購読して描画するだけにする。

ただし、上記をOverlay抽出と同時に発見的に定義しない。snapshot、command、lifecycle、pending intent、capture cancellation、navigationをcontract-only entry pointとgolden fixtureで先に固定し、その後にtransport、ClientStateV2、Controller、rendererの順で実装する。

標準UIとしてはWeb Componentが有力。

理由:

- React/Vue/Svelte/vanillaのいずれにも組み込める
- 現状のShadow DOMによるCSS隔離を継続できる
- ホスト側framework依存をなくせる
- plugin利用者へReact runtimeを要求しなくて済む

React rendererは互換層として残してよい。

---

## 8. Capabilityモデル

チケット管理製品によって可能な機能が異なるため、最低共通機能だけへ削るのではなくcapabilityを返す。

```ts
type BackendCapabilities = {
  canRead: boolean;
  canCreate: boolean;
  canReply: boolean;
  canAppendRevision: boolean;
  supportsAttachments: boolean;
  supportsWorkspaceSearch: boolean;
  supportsResourceSearch: boolean;
  supportsNativeIdentity: boolean;
  idempotency: "guaranteed" | "recoverable" | "best-effort";
  maximumEvidenceBytes: number | null;
  creationFields: CreationField[];
};
```

チケット作成時の任意フィールドも宣言的にする。

```ts
type CreationField = {
  key: string;
  label: string;
  type: "text" | "date" | "select" | "reference";
  required: boolean;
  options?: Array<{ value: string; label: string }>;
};
```

これにより、Redmineのparent issue、Jiraのcomponent、GitLabのmilestone、Azure DevOpsのarea / iteration等を共通UIから扱える。

---

## 9. DBレス設計の限界

### 9.1 冪等性

Feedback本文の専用DBを持たない場合、全ticket toolでexactly-onceを保証することは難しい。

基本方針:

1. browserで `threadId` / `intentId` を先に生成
2. ticket作成
3. timeout等で結果不明なら `intentId` で再検索
4. 見つかれば既存ticketを返す
5. 検索indexの遅延と不存在を区別できない間は`pending`を返し、自動再作成しない
6. Connectorが安全な再作成を証明できる場合だけ`not_found`を返す
7. 複数ticketが見つかった場合は`repair_required`とし、自動で一つを選ばない
8. provider側の検索整合性と回復可能性に応じてcapabilityを返す

共通仕様は `recoverable idempotency` が現実的。Feedback Serviceはidempotency ledgerを持たず、`threadId`、`intentId`、`requestHash`はEnvelope、検索projection、message markerとしてproviderへ保存する。provider検索がbest-effortの場合は、自動再作成より手動repairを優先する。

### 9.2 participant credential

現状の自己完結HMAC credentialはlegacy所有確認として維持できる。

汎用化時には追加推奨:

- `expiresAt`
- `kid`
- credential署名key ring
- participant ID導出鍵との分離
- host identity利用モード

self-contained credential単独で個別ユーザーの即時失効まで保証することは難しい。participant credentialは現行どおりbrowser profile単位の所有確認だけに使用し、利用者認証やprofileへの到達認可は後述のAuthorization Modeが担う。

### 9.3 draft / follow / unread

現状通りbrowser storageでよい。

ただし端末間同期はされない。必要ならproviderのwatch機能、任意のsmall state store、hostアプリ側profileのいずれかが必要。

### 9.4 DBレスAuthorization Mode

Feedback Serviceはserver-side認可状態を持たず、server profileごとに次のいずれかのAuthorization Modeを起動時に固定する。requestごとのmode変更やfallbackを行わない。

1. `public-profile`
   - 現行v1と同じく、profile endpointへ到達できることを認可境界とする。
   - 読み取り、新規投稿、返信を実在人物の認証で制限しない。
   - participant credentialは投稿所有と自己編集の確認にだけ使用する。
2. `signed-grant`
   - 直接OIDC access tokenまたは契約済みtoken exchange JWTに、`profileId`、`workspaceId`、許可operation、必要なresource scopeを含む短寿命の署名付きgrantを格納する。
   - requestの対象とgrantを完全一致で照合し、無関係な汎用scopeだけで認可しない。
   - 即時失効の代わりに短い有効期限を使用し、Feedback Serviceはrefresh tokenやrevocation listを保持しない。
3. `remote-authorization`
   - 即時失効が必要な場合だけ、契約済みの認可APIへrequestごとに問い合わせる。
   - host DBを直接参照せず、timeout、不正response、上流障害はfail-closedにする。

有効権限は次のように求める。

```text
effective permissions
  = authorization modeが返す許可operation
  ∩ server profile policy
  ∩ backend capability
```

provider profileはread-only設定fileまたは起動時環境設定から読み込み、credentialと署名鍵はserver-side secretから取得する。Feedback ServiceはDB、queue、persistent／shared application data cache、upload directory、object storageを使用しない。有界なin-process JWKS／provider metadata cacheは正本とせず、再起動で破棄可能とする。

---

## 10. 正本候補となるチケット管理システム

| 製品 | 現行機能維持の目安 | 評価 |
|---|---:|---|
| Redmine | 100% | 現行基準 |
| Jira Cloud | 97〜99% | 非常に高い。contract／Connector検証済み |
| Jira Data Center | 97〜99% | 事前評価。案件時に対象versionでStage Aが必要 |
| Azure DevOps Boards / Server | 96〜98% | 非常に高い |
| YouTrack | 95〜98% | 高い |
| ServiceNow | 95〜98% | 高いが導入重い |
| OpenProject | 92〜96% | 高い |
| Backlog | 92〜96% | 高い |
| GitLab Premium / Ultimate | 90〜95% | 高い |
| GitHub Issues | 82〜88% | attachment / custom fieldが弱い |
| Zendesk | 85〜90% | issue tracker用途とはやや異なる |
| Linear | 82〜89% | 高カーディナリティ検索が弱め |
| GitLab Free | 78〜85% | custom field制約が大きい |

---

## 11. 市場性・対応価値

市場シェアは厳密比較が難しいため、開発者利用率、大企業での存在感、導入社数、対象セグメントを組み合わせて判断する。

参考となる開発者接点の目安:

| 製品 | 開発者接点の目安 |
|---|---:|
| GitHub | 約80% |
| Jira | 約52% |
| GitLab | 約37% |
| Azure DevOps | 約19% |
| Linear | 約4% |
| Redmine | 約3% |
| YouTrack | 約3% |

GitHubの値はGitHub全体であり、GitHub Issues単体の市場シェアではない。

### Jira

- 市場性が非常に高い
- 大企業でも強い
- custom field、JQL、comment、attachmentが揃う
- 現行機能をほぼそのまま維持可能

Jira CloudはRedmineの次にcontract検証と正式Connector実装を完了している。この完了はJira Data Centerの互換性または実装着手を意味しない。

### Azure DevOps Boards

特にMicrosoft技術基盤、Azure、Entra ID、公共、金融、大企業で有効。Work Item、comment、attachment、WIQL、custom fieldが揃い、現行機能との相性が非常に良い。

### GitLab

セルフホスト、データ主権、DevSecOps一体型、enterprise GitLab利用組織で有効。正本として使いやすい。

### GitHub Issues

機能適合度はやや低いが、OSS、SaaS、スタートアップ、GitHub Enterprise、repository単位の軽量導入では市場価値が高い。機能縮退型connectorの検証対象としても有効。

### Backlog

日本市場では優先度が高い。非エンジニアも使いやすく、UAT / 顧客確認用途とも相性が良い。Redmine／Jira Cloudに続く第三providerとして、既存抽象の汎用性を検証する最初の後続Connectorとする。

### ServiceNow

大企業では非常に強いが、connector実装・設定が重い。先行実装より、**ServiceNow対応が受注条件になった案件で対応する**方がよい。

### Linear

SaaS / AI / product engineering企業で成長しているが、現時点ではJira Cloud / Azure DevOps / Backlogより後。

### 要望ベース

- YouTrack
- OpenProject
- Zendesk

Connector SDKを公開し、需要が出た段階で対応する。

---

## 12. 公式対応として妥当な範囲

全11製品へ公式対応する必要はない。

### 常設公式対応

```text
Redmine
Jira Cloud
Backlog
Azure DevOps
GitLab
GitHub Issues
```

この範囲で主要な開発組織と日本市場のかなり広い範囲をカバーできる。

### 市場別追加

```text
グローバルSaaS → Linear
大企業ITSM      → ServiceNow
```

Jira Data Centerは常設の実装順序へ含めず、self-hosted Jiraが導入条件となる案件または明示的な利用要望がある場合に追加する。

### SDK / Community Connector

```text
YouTrack
OpenProject
Zendesk
その他
```

---

## 13. 推奨Connector展開順

公共・金融・大企業向け業務Webを主対象とするなら、以下が妥当。

```text
既存
  Redmine

初期契約検証・正式Connector
  1. Jira Cloud

最初の後続Connector
  2. Backlog

その後の公式Connector候補
  3. Azure DevOps
  4. GitLab
  5. GitHub Issues

案件・市場次第
  Jira Data Center
  ServiceNow
  Linear

SDK / Community
  YouTrack
  OpenProject
  Zendesk
```

Jira Cloudを契約freeze前のfixture spikeに使い、正式Connectorも最初に実装する。次はBacklogを第三providerとして検証・実装し、Redmine／Jira Cloudで確立した共通層を再利用できることを確認する。Jira Data CenterはCloud対応の完了を理由に着手せず、導入案件または明示的な利用要望がある場合だけ、対象versionを固定したDBレスcontract applicability spikeから開始する。Cloud ConnectorへData Center固有の条件分岐を追加せず、Connector固有実装の要否はspike結果から決定する。

GitHub Issuesは制約が強いため、抽象設計が特定製品へ過適合していないかを検証する第二段階のテストベッドとして有効。

---

## 14. 移行ロードマップ

### Phase 0: hard gate

- v1／UI characterization
- Feedback Service実行トポロジ、Authorization Mode、OIDC／token exchange grant
- Jira Cloud先行の対象決定
- Envelope canonicalization、key ring、identity鍵分離
- 型の正本とv1／v2 security boundary

### Phase 1: 契約draftとpackage skeleton

- wire query／command／page／cursor／result／problem
- server向け`FeedbackRepositoryPort`
- browser向け`FeedbackClientPort`
- `FeedbackAuthorizationPort`、Authorization Mode、provider profile schema
- controller snapshot／commandとgolden fixture
- stable ID、ordering、unread規約
- 全package skeleton、依存DAG、root script、lockfile

### Phase 2: Jira Cloud contract spikeと契約freeze

Redmine／Jira fixture、fake、TCK、Envelope codecを作り、Jira Cloudのissue、comment、property、pagination、attachment、creation field、intent回収で抽象を検証する。同時に3つのAuthorization Mode、profile固定、signed grant対象照合、remote authorizationのfail-closedをfixtureで固定する。本番consumerの実装前に契約をfreezeする。

### Phase 3: freeze後の並列実装

次の4 laneへ分ける。

1. stateless Feedback Service、Authorization Adapter、profile／secret loader、gateway application service
2. Redmine mapper、legacy reader、Envelope／projection、dual-writeを同一ownerのstacked PR
3. Jira Cloud Connector
4. generic transport、ClientStateV2、Headless Controller

### Phase 4: renderer

Controllerとgolden snapshotが安定した後、React rendererとWeb Componentを並列実装する。

### Phase 5: v1／v2統合とrelease

partial writeを含むcompatibility matrix、provider acceptance、browser E2E、rollback、key rotationを直列統合する。

### 後続Connector

Backlogを最初の後続Connectorとしてprovider差を検証する。その後はAzure DevOps、GitLab、GitHubの順を候補とし、GitHubではattachment、custom field、検索制約がある環境でも成立するfallbackを検証する。Jira Data Centerは案件・利用要望がある場合だけStage Aから評価し、既定の実装順序には含めない。

後続ConnectorはRedmine／Jira Cloudで確立した共通契約と実装を優先し、providerごとの縦割り実装を増やさない。まずDBレスcontract applicability spikeで、ticket管理システムだけを正本として最初のwrite、検索、操作回復、attachment mappingが成立するかを確認する。通過後はprovider非依存処理を共通packageとserver-side adapter registryへ置き、Connector固有実装をHTTP transport、credential wire形式、DTO mapper、検索構文、metadata保存位置、provisioningへ限定する。provider能力の不足はcapabilityと保証水準で表現し、補完用DBやprovider外storageを追加しない。

---

## 15. 最終的な設計方針

この基盤の本質は、Redmine pluginでもReact widgetでもなく、

> **業務アプリ上の特定の画面・データ・位置に紐づいたFeedback Threadを、外部チケット管理システムを正本として管理するための共通プロトコル**

と定義するのがよい。

設計上の中心は以下になる。

```text
Feedback Protocol / Domain Model
        ↓
Headless Feedback Controller
        ↓
Feedback Gateway
        ↓
FeedbackRepositoryPort
        ↓
Ticket System Connector
```

React、Web Component、Redmine、Jira、GitHub等はすべて周辺実装とする。

また、Feedback ServiceがDB、queue、persistent／shared application data cache、upload directory、object storageを持たず、Feedback本文と操作回復に必要なmetadataの正本をticket管理システムへ置くことを主要価値として前面に出せる。

- 導入が軽い
- 既存ticket workflowをそのまま使える
- 運用チームが新システムを覚えなくてよい
- バックアップ・監査・権限管理を既存toolへ委譲できる
- ベンダーロックインをconnector単位に閉じ込められる

## 2026-09-07の契約更新

DBレス継続・重複排除best-effortの利用者判断に基づき、[Thread Reference v1](contracts/feedback/thread-reference.md)と[ADR 0005](docs/adr/0005-protected-thread-reference.md)を採用する。provider検索だけによる全体的一意性を初期v2の保証としない。参照取得後はscopeに束縛した暗号化参照で同じticketへ固定する。生のprovider参照公開を禁止する境界、毎回の認可・Envelope・projection検証、v1互換、専用永続storage禁止は維持する。
