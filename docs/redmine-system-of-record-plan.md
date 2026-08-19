# Redmineを完全なデータ正本とするDBレスFeedback JavaScriptプラグイン／ブラウザ拡張 実装計画・詳細設計

## 1. 文書の位置付け

この文書は、Feedbackの業務データをすべてRedmineへ保存し、Feedback専用PostgreSQL、object storage、OIDC、同期workerを
持たないclient pluginとして実装するための詳細設計である。

- 標準配布形態は、顧客の業務appへ埋め込むJavaScriptプラグインとする。
- 代替配布形態としてChrome / Microsoft EdgeのManifest V3拡張機能を維持する。
- UI、Redmine保存schema、thread組立、validation、未読計算は両形態で同じ実装を使う。
- 埋め込み版は、業務appと同一originのstateless gatewayを介してRedmine RESTへ接続する。
- 拡張機能版はextension service workerからRedmine RESTへ直接接続する。
- threadの初回投稿だけをFeedback UIから受け付ける。
- 初回投稿後のdescription、全返信、状態、担当者、優先度、添付、変更履歴はRedmineから参照専用で表示する。
- Feedback側のDB、同期cache、監査DB、Export storageは設けない。埋め込み版gatewayもDBや業務data cacheを持たない。
- Feedback独自OIDCは使わない。埋め込み版は業務appの既存login session、拡張機能版は個人Redmine API keyを使う。
- 公開契約は引き続き`contracts/feedback`を正本とし、共通operation contract、gateway HTTP contract、extension内部message
  contract、Redmine保存schemaを追加する。
- 実装完了の判定には`bash scripts/verify-feedback.sh`の成功を必須とする。

本文中の`MUST`は実装・受入に必須、`MUST NOT`は禁止、`SHOULD`は合理的な例外がない限り必須とする。

## 2. 結論

この構成では、完成後のFeedback System側にDBは不要である。業務app埋め込みも可能であり、browser拡張のinstallを必須にしない。

Redmine issueをthread、issue descriptionを最初のcomment、journal notesを返信、issue status/assignee/priorityを管理状態、
attachmentsをスクリーンショットとcontextの正本にする。Feedback clientはRedmineを都度参照してUIへ投影するだけであり、
server-side synchronizationを行わない。

ただし、埋め込みJavaScript単体へRedmine API keyをbuild設定や初期化optionとして渡してはならない。browserへ配信したsecretは
DevToolsやpage scriptから読めるため、埋め込み版には顧客管理下の同一origin gatewayが必要である。このgatewayはRedmine keyを
server-side secretとして保持し、許可されたFeedback操作だけを中継する。DB、queue、cache、同期処理を持たないため、Redmineが
唯一の業務データ正本であることは変わらない。

browser内には次のclient状態だけを保持する。いずれもRedmine業務データの正本ではない。

- application/environment/external workspace、UI、captureなどの非secret設定。
- 拡張機能版だけ、browser再起動までの個人API key。
- 投稿処理中のthread UUIDとrequest hash。
- 端末内だけの既読位置。
- 未送信draft。送信成功時に削除する。

## 3. 確定したプロダクト判断

1. Feedback独自OIDC、token exchange、membershipは廃止する。
2. 標準導入方法は、業務appへ埋め込むJavaScriptプラグインとする。
3. Chrome / Edge拡張機能は、業務appを変更できない顧客向けの代替導入方法として残す。
4. 埋め込み版は業務appの既存認証・認可を再利用し、同一originのstateless gatewayだけを経由する。
5. 拡張機能版は利用者個人のRedmine API keyとRedmine project roleを使う。
6. 共有service account API keyをJavaScript bundle、HTML、browser storage、extension packageへ配布・埋め込みしない。
7. Feedback thread 1件をRedmine issue 1件へ対応させる。
8. Feedback UIからのwriteは初回issue作成だけとする。
9. 返信、description編集、status、assignee、priority、attachment追加はRedmine UIで行う。
10. Feedback UIはRedmineの現在値と全journalを参照専用で表示する。
11. 未読情報は端末内だけでよく、複数端末同期を行わない。
12. Redmine停止時のoffline queue、server retry、可用性監視は実装しない。errorを表示し、同じ投稿を利用者がretryする。
13. Feedback独自のcentralized sync監視・監査ログは実装しない。
14. Feedback独自の証跡Exportは実装しない。証跡の正本とExport責任はRedmineへ委ねる。
15. 既存Feedback DBにデータがある場合だけ、一度限りのmigration CLIを使用し、移行・照合後にDBを廃止できるようにする。
16. Redmine plugin、webhook、DB直接参照は使用せず、標準REST APIだけを使用する。
17. リアクションは実装しない。

## 4. 目標と非目標

### 4.1 目標

- JavaScript bundleを業務appへ組み込み、同一origin gateway endpointとhost adapterを設定して利用できる。
- 業務appを変更できない場合は、拡張機能へRedmine URL、project/tracker/custom field ID、個人API keyを設定して利用できる。
- 業務画面上のlocation/targetとスクリーンショットを伴うissueをRedmineへ作成できる。
- 同じ投稿をretryしても`Feedback Thread ID`を使って重複issueを作らない。
- Redmineで行われた全返信と主要field changeをFeedback UIから参照できる。
- thread drawerを開いている間は30秒周期でRedmineの最新状態へ更新する。
- 最初のcommentをthread一覧の主表示、最新返信を補助表示にする。
- 端末内の既読位置から「自分がfollowしているthreadへの未読返信」badgeを表示する。
- 埋め込み版は業務appの既存権限とgatewayの固定scope、拡張機能版はRedmine project permissionを使い、Feedback独自user DBを持たない。
- Feedback threadをRedmineだけから再構築できる。

### 4.2 非目標

- Feedback業務データ用server、DB、object storage、worker、adapterの運用。
- browserへ埋め込んだ共有Redmine API keyによるgatewayなしの直接接続。
- 任意URL、任意HTTP method、任意headerを通す汎用Redmine proxy。
- Feedback UIからの返信、編集、status変更、triage、reaction。
- 未読情報、draft、設定の複数端末同期。
- Redmine停止中の投稿受付、background retry、SLA監視。
- Feedback独自のaudit log、backup、retention、evidence package。
- Redmine全projectを横断する高機能検索engine。
- Redmineのwiki、time entry、relation、subtask、repository情報の再現。
- Firefox / Safari対応。初版のChrome / Edge完了後に別計画とする。
- Redmine間migration、複数issueを1 threadへ束ねる機能。

## 5. centralized同期監視・監査を実装しない理由

### 5.1 centralized同期監視とは

管理型serverが全workspaceについて次を収集・監視する仕組みを指す。

- Redmineの最終取得時刻。
- Redmine更新からlocal cacheまでの遅延。
- polling失敗、credential失効、未同期件数。
- migration backlog、worker health。

本計画ではlocal cacheへ同期せず、利用者が一覧・threadを開いた時点でRedmineを直接読む。そのため「同期遅延」や
「未同期件数」が存在せず、この監視は不要である。表示requestが失敗した場合だけ、そのbrowserへ接続errorを表示する。

### 5.2 Feedback独自監査ログとは

管理型serverで次を記録する仕組みを指す。

- binding設定を変更した主体。
- Feedback APIからthread/status等を更新した主体。
- Exportを生成・downloadした主体。
- synchronization workerが適用した変更。

本計画ではclient設定は業務appまたはbrowser内、gateway secret設定は顧客のsecret管理、thread更新はRedmine、ExportはRedmine側で
行う。issue変更はRedmine journalにauthorと時刻が残るため、Feedback独自監査は重複する。なお、誰がFeedback UIでissueを
閲覧したかは記録しない。閲覧監査が将来必要になった時点で、DBレス要件とは別の監査基盤を検討する。

## 6. データ所有権

| データ | 正本 | Feedback clientでの扱い |
| --- | --- | --- |
| thread | Redmine issue | 都度取得して表示 |
| 最初のcomment | issue description | 一覧・詳細に表示 |
| 返信 | journal notes | issue詳細から全件表示 |
| status / assignee / priority | issue fields | exact nameを表示 |
| field change履歴 | journal details | activityとして表示 |
| スクリーンショット | issue attachment | 認証付きでpreview |
| location / target / page | custom fields + context attachment | pin復元に使用 |
| 投稿者 | Redmine issue author + context | 個人API keyによりRedmine userと一致 |
| thread UUID | `Feedback Thread ID` custom field | 冪等性・deep linkに使用 |
| 既読位置 | 端末のlocal state | 端末固有。Redmineへ書かない |
| gateway用API key | 顧客server-side secret store | browserへ返さない |
| 拡張機能用個人API key | `chrome.storage.session` | browser再起動で消去 |
| 未送信draft | `sessionStorage`または`chrome.storage.session` | 成功時削除 |
| pending intent | `localStorage`または`chrome.storage.local` | 本文を含めず、成功・破棄時削除 |

## 7. 全体アーキテクチャ

### 7.1 共通layer

```text
業務画面 DOM / host adapter
          |
          v
Feedback Redmine UI (React + Shadow DOM)
          |
          v
RedmineFeedbackPort（operation単位の共通contract）
          |
          +--------------------------+
          |                          |
          v                          v
embedded gateway transport     extension message transport
          |                          |
          v                          v
同一origin stateless gateway   Manifest V3 service worker
          |                          |
          +------------+-------------+
                       |
                       v
                 Redmine REST API
          issue / journals / attachments / custom fields
```

UIはHTTP path、`chrome.runtime`、API keyの存在を知らない。次のoperationだけを持つ`RedmineFeedbackPort`へ依存する。

- `getCapabilities`
- `getCurrentUser`
- `listThreads`
- `getThread`
- `createThread`
- `getAttachment`
- `markRead`、`followThread`、`getUnread`。これらはtransportを通さずclient state adapterへ委譲してもよい。

genericな`request(url, method, headers)`は公開しない。gatewayとservice workerの双方で、operationから固定Redmine endpointを組み立てる。

### 7.2 埋め込みJavaScriptプラグイン

```text
業務app bundle / self-hosted ESM
  |
  | createRedmineFeedbackPlugin(options)
  v
Shadow DOM内のFeedback UI
  |
  | same-origin HTTPS、credentials/mode: same-origin、CSRF protection
  v
顧客業務appの /internal/feedback-redmine/v1/*
  |
  | server-side X-Redmine-API-Key
  v
Redmine REST API
```

- pluginはReactを内部利用してよいが、公開APIはframework非依存のJavaScript facadeにする。
- NPM/ESM importとself-hosted ESM bundleの両方を生成する。remote CDNをruntime依存にしない。
- `mount`先Element、host adapter、非secret profile、gateway base pathを受け取り、`destroy()`でlistener、timer、Blob URL、React rootを破棄する。
- gateway base pathは同一originのrelative pathだけを許可する。absolute URLを拒否する。
- 業務appの既存session cookieを`credentials: "same-origin"`で使う。Feedback独自login画面やOIDC redirectを追加しない。
- gatewayは業務appの認証middlewareの後段に置き、未認証requestを401、Feedback利用権限がない主体を403にする。
- POST/uploadは業務app標準のCSRF protectionを必須にする。clientから渡したuser ID、role、author名を認可根拠にしない。
- gatewayはresponseを共通contractへnormalizeし、Redmine raw response、API key、任意headerをbrowserへ露出しない。

### 7.3 Chrome / Edge拡張機能

- content scriptはhost context、location、target取得とUI mountだけを行う。
- React UIから`chrome.runtime` messageを介してservice workerへ共通operationを送る。
- service workerだけが個人API keyを保持し、Redmine RESTへcross-origin requestする。
- options pageはprofile設定、host permission要求、API key unlockを行う。
- enterprise managed policyは非secret profileだけを配布する。
- content script、host page、managed policyへAPI keyを返さない。

### 7.4 gatewayの責務と禁止事項

gatewayはFeedbackの中央serviceではなく、各顧客の業務app側へ置く薄いRedmine access layerである。

| 責務 | 内容 |
| --- | --- |
| authentication | 業務appの既存sessionを検証する |
| authorization | application/environment/external workspace/profile/resourceと操作権限をserver設定から決める |
| credential | Redmine API keyをserver-side secretから読む |
| allowlist | 7.1のoperationだけを受け付け、固定project/tracker/custom fieldへ制限する |
| validation | request/responseを公開schemaで検証する |
| identity | host principalをserver側で取得し、11.5の投稿者metadataへ注入する |
| upstream | timeout、size、redirect、content type policyを適用してRedmineへ接続する |

gateway libraryのhost SPIを次へ固定する。

```ts
type GatewayHostPrincipal = {
  subjectId: string;
  displayName: string | null;
  redmineUserId: number | null;
};

type AuthorizedHostResource = {
  resourceKey: string; // Redmineへ保存するopaque key、1〜200文字
};

type FeedbackRedmineGatewayHost = {
  authenticate(request: Request): Promise<GatewayHostPrincipal | null>;
  authorizeProfile(input: {
    principal: GatewayHostPrincipal;
    operation: "read" | "create";
    profileId: string;
  }): Promise<boolean>;
  authorizeResource(input: {
    principal: GatewayHostPrincipal;
    operation: "list" | "create";
    profileId: string;
    resourceRef: FeedbackHostResourceRefV1;
  }): Promise<AuthorizedHostResource | null>;
  authorizeStoredResource(input: {
    principal: GatewayHostPrincipal;
    operation: "detail" | "attachment";
    profileId: string;
    storedResourceKey: string;
  }): Promise<boolean>;
  verifyCsrf(input: {
    request: Request;
    principal: GatewayHostPrincipal;
    token: string;
  }): Promise<boolean>;
};
```

- unauthenticatedは401、profile read/create拒否は403、list/create resource拒否は403とする。
- detail/attachmentのstored resource拒否は、thread/attachmentの存在を漏らさない404とする。
- `subjectId`、`resourceKey`、`redmineUserId`はhook戻り値だけを信頼し、同名client fieldを常に破棄する。

gatewayは次をMUST NOTとする。

- DB、永続queue、issue/journal cache、attachment storageを持つ。
- request/response body、API key、cookieをapplication logへ記録する。
- client指定のRedmine URL、project ID、tracker ID、custom field ID、HTTP method、headerをそのまま使う。
- Redmine administrator keyまたは`X-Redmine-Switch-User`を使う。
- Feedback以外のRedmine issueをID指定だけで取得する。
- gatewayのservice accountで許可されていないRedmine dataをbrowserへ返す。

### 7.5 repository上の構成

```text
packages/feedback-redmine-core/
  src/port/              # RedmineFeedbackPort、共通operation DTO
  src/model/             # thread、journal、attachment normalization
  src/redmine/           # REST DTO、marker、subject/context生成
  src/client-state/      # draft、pending intent、follow、既読interface
packages/feedback-redmine-react/
  src/                   # 共通list/drawer/capture/read-only UI
packages/feedback-redmine-plugin/
  src/                   # framework非依存mount facade、gateway transport
  tests/fixtures/        # React/Vue/vanilla host fixture
packages/feedback-redmine-gateway/
  src/                   # stateless handler、auth/authz/CSRF SPI、Redmine接続
apps/feedback-redmine-extension/
  manifest.json
  src/background/        # service worker、Redmine client、credential vault
  src/content/           # content script、host bridge、共通UI mount
  src/options/           # 接続設定・検証
  src/storage/           # chrome local/session/managed adapter
apps/feedback-redmine-gateway-reference/
  src/                   # gateway packageの顧客backend組込例
contracts/feedback/
  schemas/               # 共通/gateway/extension/Redmine保存schema
```

- `packages/feedback-core`のhost context/location/target schemaとhost adapterを再利用する。
- `packages/feedback-react`の公開済み`createDomEvidenceProvider`だけを再利用し、既存packageは変更しない。Redmine専用pin/Shadow DOM/UIは
  `packages/feedback-redmine-react`へ実装する。
- Redmine DTO normalizationをgatewayとextensionで重複実装しない。browser-safeなpure moduleとして共通化する。
- `packages/feedback-admin-react`は既存server admin console用のまま変更しない。
- plugin artifactはESM packageとself-hosted bundle、extension artifactはunpacked directoryと署名用ZIPを生成する。

## 8. Redmine対応範囲

### 8.1 version

- 最低対応versionはRedmine 5.1とする。
- CIはRedmine 5.1、6.0、6.1、7.0の最新patchに対するcontract testを持つ。
- runtimeはproduct version endpointへ依存せず、接続検証で必要なREST capabilityを実動作確認する。
- issue、journal、attachmentの標準REST仕様を利用する。

公式仕様:

- [Issues REST](https://www.redmine.org/projects/redmine/wiki/rest_issues)
- [Journals REST](https://www.redmine.org/projects/redmine/wiki/Rest_Journals)
- [Attachments REST](https://www.redmine.org/projects/redmine/wiki/Rest_Attachments)
- [REST API authentication](https://www.redmine.org/projects/redmine/wiki/REST_Api#Authentication)
- [Attaching files](https://www.redmine.org/projects/redmine/wiki/Rest_api#Attaching-files)

### 8.2 必須Redmine設定

1. REST APIを有効化する。
2. Feedback対象projectとtrackerを決める。
3. 埋め込み版ではFeedback専用integration userをproject memberにし、issue閲覧、追加、attachment追加だけを許可する。
4. 拡張機能版では利用者をproject memberにし、個人API keyを発行できるようにする。
5. Feedbackから作成するissueをprivateにする場合は、使用するintegration userまたは利用者へprivate issue追加・閲覧権限を与える。
6. 8.3のcustom fieldを作成し、project/trackerへ割り当てる。
7. Redmineの最大attachment sizeをFeedback screenshot上限以上にする。
8. integration userをRedmine administratorにせず、他projectのmemberにしない。
9. 埋め込み版の専用project/roleではprivate noteを使用せず、integration userへprivate note閲覧権限を与えない。
10. private noteを含む利用者別Redmine可視性が必要な場合は、個人key resolverまたは拡張機能版を使用する。

### 8.3 必須custom field

| logical key | 推奨表示名 | Redmine形式 | `Used as a filter` | 用途 |
| --- | --- | --- | --- | --- |
| `threadId` | Feedback Thread ID | text 1行 | 必須 | 冪等性・thread取得 |
| `requestHash` | Feedback Request Hash | text 1行 | 不要 | retry時の同一投稿照合 |
| `applicationKey` | Feedback Application Key | text 1行 | 必須 | application分離 |
| `environmentKey` | Feedback Environment Key | text 1行 | 必須 | environment分離 |
| `externalWorkspaceKey` | Feedback External Workspace Key | text 1行 | 必須 | external workspace分離 |
| `pageKey` | Feedback Page Key | text 1行 | 必須 | 現在画面のthread一覧 |
| `hostResourceKey` | Feedback Host Resource Key | text 1行 | 必須 | 業務resource単位の認可・filter |
| `perspectiveCode` | Feedback Perspective | text 1行 | 推奨 | 観点filter |
| `locator` | Feedback Locator | long text | 不要 | location/targetの一覧用compact JSON |
| `submittedById` | Feedback Submitted By ID | text 1行 | 不要 | 埋め込み版のhost principal識別子 |
| `submittedByName` | Feedback Submitted By | text 1行 | 不要 | 埋め込み版の表示名 |
| `submissionChannel` | Feedback Submission Channel | list | 任意 | `embedded`または`extension` |

- field IDは環境ごとに異なるためserver profileまたはextension profileへnumeric IDを設定する。
- field名で自動推測しない。
- `threadId`は単一値、36文字UUID、multipleでないことを接続検証する。
- `requestHash`は64文字lowercase SHA-256 hex、`hostResourceKey`はgatewayが認可後に生成したopaque値とする。
- Redmineはcustom fieldのunique constraintを保証しない。thread ID検索が2件以上ならfail-closedする。
- locatorはfilterへ使用せず、issue一覧responseのcustom field valueから読み取る。
- 埋め込み版の`submittedById`はgatewayが既存session principalから生成するstable opaque IDとし、client payload値を無視する。
- `submittedByName`に個人名を保存するかは顧客の個人情報方針に従い、未許可ならopaque IDだけを保存する。
- service account方式ではRedmine issue authorはintegration userになる。実投稿者は上記custom fieldとcontext attachmentを正本とする。
- Redmine author自体を実利用者にする必要がある顧客は拡張機能版を選ぶ。既存backendが利用者別Redmine key resolverを既に持つ場合だけ、
  gatewayへそのresolverを注入してもよい。Feedbackがkey mapping DBを新設してはならない。
- profileごとに専用integration user/projectを割り当て、異なるsecurity boundaryを1つのservice accountへ束ねない。

## 9. profile・plugin設定

### 9.1 共通client profile

JavaScriptプラグインと拡張機能がUIへ渡す公開設定は、secretやRedmine内部接続情報を含まない。

`contracts/feedback/schemas/redmine-client-profile.schema.json`:

```json
{
  "schemaVersion": "1",
  "id": "inventory-production",
  "displayName": "Inventory / Production",
  "applicationKey": "inventory",
  "environmentKey": "production",
  "externalWorkspaceKey": "production-review",
  "perspectives": [
    { "code": "ux", "label": "UI/UX" },
    { "code": "business", "label": "業務" }
  ],
  "capture": {
    "enabled": true,
    "maximumUploadBytes": 10485760,
    "contentTypes": ["image/png", "image/webp"]
  },
  "attachments": {
    "maximumInlinePreviewBytes": 10485760,
    "maximumDownloadBytes": 52428800
  }
}
```

- profile IDは`^[a-z0-9][a-z0-9._-]{0,99}$`、key類は1〜100文字、external workspace keyは200文字以内。
- perspective codeはprofile内で一意。uploadは1〜10 MiB、inline previewは1〜10 MiB、downloadはinline以上50 MiB以下を初版上限とし、
  gateway/Redmine上限以下でなければならない。
- `redmineBaseUrl`、project/tracker/custom field ID、API keyは共通client profileへ含めない。
- gatewayの`GET /profiles/{profileId}`が返す値を優先し、host contextのapplication/environment/external workspaceと一致しなければ停止する。

### 9.2 JavaScriptプラグイン初期化contract

```ts
type RedmineFeedbackPluginOptions = {
  mount: Element;
  profileId: string;
  gatewayBasePath?: string; // default: "/internal/feedback-redmine/v1"
  adapter: FeedbackRedmineHostAdapter;
  getCsrfToken: () => string | Promise<string>;
  messages?: Partial<FeedbackMessages>;
  onUnavailable?: (error: unknown) => void;
};

type FeedbackHostResourceRefV1 = {
  schemaVersion: "1";
  kind: "record" | "page";
  key: string;
};

type FeedbackRedmineHostAdapter = Pick<
  FeedbackHostAdapter,
  "getContext" | "getLocation" | "subscribe" | "navigate" | "captureEvidence"
> & {
  getResourceRef(): FeedbackHostResourceRefV1;
};

type RedmineFeedbackPluginHandle = {
  refresh(): Promise<void>;
  openThread(threadId: string): Promise<void>;
  clearLocalState(principalScopeHash: string): Promise<void>;
  downloadDiagnostics(): void;
  destroy(): void;
};
```

利用例:

```ts
import { createRedmineFeedbackPlugin } from "@feedback/redmine-plugin";

const feedback = createRedmineFeedbackPlugin({
  mount: document.querySelector("#feedback-root")!,
  profileId: "inventory-production",
  gatewayBasePath: "/internal/feedback-redmine/v1",
  adapter: inventoryFeedbackAdapter,
  getCsrfToken: () => inventoryCsrfToken
});
```

- `gatewayBasePath`は`/`で始まる同一origin relative pathだけを許可し、`//`、backslash、userinfo、query、fragment、dot segmentを拒否する。
- API key、Authorization header、Redmine URLをoption型に定義しない。unknown propertyをruntime validationで拒否する。
- `FeedbackRedmineHostAdapter`は`FeedbackHostAdapter`のcontext/location/subscribe/navigate/captureEvidenceだけと、
  `getResourceRef()`を持つ新しい型である。`getAccessToken`、`refreshAccessToken`、Feedback identityを要求しない。
- 既存`FeedbackHostAdapter`実装は`getResourceRef`を加える薄いwrapperで再利用できるが、その既存型自体は変更しない。
- resource refのclient `key`は認可済みとはみなさない。gateway authorization hookがhost principalと業務app dataから検証・正規化し、
  Redmineへ保存するopaque `hostResourceKey`を返す。
- `getCsrfToken`は必須で、業務app標準のnonempty CSRF tokenを返す。POST/uploadでは固定header `X-Feedback-CSRF`へ設定する。
- `mount`済みElementへの二重mountはerror。`destroy()`は冪等にする。
- server-side rendering中はDOMへaccessせず、明示mount時だけ初期化する。

### 9.3 gateway server profile

gatewayにだけ次を設定する。値はclient requestでoverrideできない。

```json
{
  "profileId": "inventory-production",
  "clientProfileRef": "inventory-production.client.json",
  "redmineBaseUrl": "https://redmine.example.invalid",
  "projectId": 12,
  "trackerId": 4,
  "isPrivate": true,
  "defaultPriorityId": 2,
  "customFieldIds": {
    "threadId": 21,
    "requestHash": 22,
    "applicationKey": 23,
    "environmentKey": 24,
    "externalWorkspaceKey": 25,
    "pageKey": 26,
    "hostResourceKey": 27,
    "perspectiveCode": 28,
    "locator": 29,
    "submittedById": 30,
    "submittedByName": 31,
    "submissionChannel": 32
  },
  "authorizationMode": "resource-scoped",
  "showRedmineLink": false,
  "secretRef": "FEEDBACK_REDMINE_GATEWAY_API_KEY"
}
```

- Redmine base URLはHTTPS必須。subpath配備は許可するがquery/fragment/userinfo/dot segmentを拒否する。
- numeric IDは1以上、custom field IDはprofile内で重複不可。
- `clientProfileRef`は9.1 schemaへ適合するlocal/read-only設定を参照し、profile IDを完全一致させる。
- 初版の`authorizationMode`は`resource-scoped`だけを許可し、profile全体を全利用者へ開示するmodeを実装しない。
- `secretRef`が参照するAPI keyに既定値を設けない。startup時に未設定ならgatewayをfail-fastする。
- file/env/secret managerのどれでprofileを供給してもよいが、API keyをprofile responseやdiagnosticへserializeしない。
- 新しい環境変数を実装したchangeで`docs/environment-variables.md`を更新する。

### 9.4 extension profile

`contracts/feedback/schemas/redmine-extension-profile.schema.json`を追加する。

```json
{
  "schemaVersion": "1",
  "profiles": [
    {
      "id": "inventory-production",
      "displayName": "Inventory / Production",
      "applicationKey": "inventory",
      "environmentKey": "production",
      "externalWorkspaceKey": "production-review",
      "hostOrigins": ["https://inventory.example.invalid"],
      "redmineBaseUrl": "https://redmine.example.invalid",
      "projectId": 12,
      "trackerId": 4,
      "isPrivate": true,
      "defaultPriorityId": 2,
      "customFieldIds": {
        "threadId": 21,
        "requestHash": 22,
        "applicationKey": 23,
        "environmentKey": 24,
        "externalWorkspaceKey": 25,
        "pageKey": 26,
        "hostResourceKey": 27,
        "perspectiveCode": 28,
        "locator": 29,
        "submittedById": 30,
        "submittedByName": 31,
        "submissionChannel": 32
      },
      "perspectives": [
        { "code": "ux", "label": "UI/UX" },
        { "code": "business", "label": "業務" }
      ],
      "capture": {
        "enabled": true,
        "maximumUploadBytes": 10485760,
        "contentTypes": ["image/png", "image/webp"]
      },
      "attachments": {
        "maximumInlinePreviewBytes": 10485760,
        "maximumDownloadBytes": 52428800
      }
    }
  ]
}
```

### 9.5 extension profile validation

- profile IDは`^[a-z0-9][a-z0-9._-]{0,99}$`、重複不可。
- key類は1〜100文字、external workspace keyは200文字以内。
- host originはHTTPS originだけを許可し、path/query/fragment/userinfoを禁止する。
- Redmine base URLはHTTPSを必須とする。subpath配備は許可するがquery/fragment/userinfo/dot segmentを拒否する。
- local developmentでだけHTTPを許可し、build flavor `development`に限定する。
- numeric IDは1以上。
- custom field IDはprofile内で重複不可。
- perspective codeはprofile内で一意。
- API keyをprofile JSONへ含めた入力はschema validationで拒否する。

### 9.6 extension profile保存優先順位

1. `chrome.storage.managed`のenterprise policy profile。
2. options pageからimportした`chrome.storage.local` profile。
3. 開発buildだけのfixture profile。

- 同じprofile IDがmanagedとlocalにある場合はmanagedを採用し、localでoverrideできない。
- managed/localには非secret設定だけを保存する。
- profile変更時は関連するhost permissionを再確認する。

### 9.7 browser permission

- manifestは`storage`、`scripting`、`activeTab`を要求する。
- runtime設定の任意HTTPS originを許可候補にするため、manifestの`optional_host_permissions`には`https://*/*`を宣言するが、
  required `host_permissions`へは入れない。
- options pageの利用者操作から、validation済み業務画面originとRedmine originの完全一致match patternだけを
  `chrome.permissions.request`へ渡す。`https://*/*`自体を実grant requestしない。
- profile削除時は、そのoriginを使う他profileがない場合だけ`chrome.permissions.remove`する。
- content scriptは許可済み`hostOrigins`だけへprogrammatic registrationする。
- Redmine cross-origin fetchはservice workerからだけ行う。
- extensionの`hostResourceKey`はcanonical resource refのSHA-256とし、raw業務IDをRedmine custom fieldへ保存しない。extensionでは
  個人Redmine permissionを最終認可境界とし、gatewayのhost resource authorizationを再現しない。

## 10. 認証・API key・投稿者identity

### 10.1 原則

- Feedback独自OIDCは実装しない。
- 埋め込み版は業務appの既存session、拡張機能版は利用者本人のRedmine API keyを使用する。
- shared key、admin key、service account keyをJavaScript、HTML、extension package、managed profileへ埋め込まない。
- requestではquery parameterやBasic authを使わず`X-Redmine-API-Key` headerを使用する。
- HTTPS以外へkeyを送信しない。
- redirect先へkeyをforwardしない。3xxはerrorにする。

### 10.2 埋め込み版

- browserからgatewayへのrequestは業務appのsame-origin session cookieで認証する。
- gatewayは業務appのserver-side principalからopaque subject ID、表示名、利用可能profileを得る。
- gateway用Redmine integration keyはenvironment secretまたは顧客secret managerに置き、process memory以外へ複製しない。
- gateway response、HTML、source map、client configuration、logへkeyを出さない。
- browserが送った`submittedById`、`submittedByName`、project/tracker/custom field IDは無視し、server値で上書きする。
- session認証がcookie方式なら、SameSiteだけに依存せず業務app標準のCSRF token/origin checkをPOST/uploadへ適用する。
- gatewayはprofileごとにhost role/permission predicateを持ち、readとcreateを別権限として評価する。

埋め込み版のissue authorはintegration userである。実投稿者はRedmine custom fieldとcontext attachmentへ、gatewayが認証済みhost
principalから記録する。Redmine自身のauthor欄を実利用者に一致させることを必須とする顧客には拡張機能版を案内する。

### 10.3 拡張機能版

- options pageで入力したkeyを`chrome.storage.session`へprofile ID単位で保存する。
- browser再起動、extension update/disableでkeyが消えた場合はprofileを`locked`表示にし、再入力を要求する。
- `chrome.storage.local`、`storage.sync`、IndexedDB、log、crash reportへ保存しない。
- content scriptへkeyをmessage responseで返さない。
- service worker内でもrequest header構築直前にだけ読み、長寿命objectへcopyしない。

Chrome extension storageは暗号化されたsecret storeではないため、永続key保存は初版で提供しない。

### 10.4 current user

- 埋め込み版はgatewayがhost principalとintegration userを別々に返し、UIへはhost display identityだけを返す。
- 拡張機能版はunlock直後に`GET /users/current.json`を呼び、user ID、login、firstname、lastnameだけをmemoryへ保持する。
- responseにAPI key fieldが含まれてもdecode後に捨て、raw responseをlogへ出さない。
- 拡張機能版のissue authorはRedmineがAPI key userとして記録する。
- いずれのmodeでもclient表示名やcustom fieldをgateway/Redmine権限判断へ使用しない。

## 11. Redmine上のデータ表現

### 11.1 issue mapping

| Redmine field | 値 |
| --- | --- |
| `project_id` | profile `projectId` |
| `tracker_id` | profile `trackerId` |
| `subject` | 11.2の生成値 |
| `description` | 初回comment + metadata block |
| `priority_id` | profile `defaultPriorityId`。nullなら送らない |
| `is_private` | profile `isPrivate` |
| custom field `threadId` | UUID v4 |
| custom field `requestHash` | trusted connectorが計算したSHA-256 |
| custom field `applicationKey` | profile値 |
| custom field `environmentKey` | host contextとprofileの一致確認済み値 |
| custom field `externalWorkspaceKey` | host contextとprofileの一致確認済み値 |
| custom field `pageKey` | host context値 |
| custom field `hostResourceKey` | gateway authorization hookまたはextension profileが正規化したopaque値 |
| custom field `perspectiveCode` | form選択値 |
| custom field `locator` | compact JSON |
| custom field `submittedById` | 埋め込み: gatewayが得たopaque host subject。拡張: Redmine user ID文字列 |
| custom field `submittedByName` | 保存許可時の表示名。未許可なら空 |
| custom field `submissionChannel` | `embedded`または`extension` |
| uploads | context JSON + optional screenshot |

### 11.2 subject

1. 初回commentの最初の非blank行を選ぶ。
2. 連続whitespaceをASCII space 1文字へ正規化する。
3. control characterを除く。
4. `[{perspectiveCode}] {line}`を作る。
5. lineが空なら`[{perspectiveCode}] Feedback {threadId}`。
6. 255 Unicode scalar valueを超える場合は末尾を`…`として255以内へ切る。

### 11.3 description

```text
{initialComment}

---
Feedback metadata v1
Thread ID: {threadId}
Intent ID: {intentId}
Request hash: {requestHash}
Application: {applicationKey}
Environment: {environmentKey}
External workspace: {externalWorkspaceKey}
Page: {pageKey}
Host resource: {hostResourceKey}
Perspective: {perspectiveCode}
Submission channel: {embedded|extension}
Submitted by ID: {opaqueSubject|redmineUserId}
Captured at: {RFC3339Nano UTC}
Context attachment: feedback-context-v1.json
```

- 最初のcommentを先頭へ置き、一覧で最重要情報として見えるようにする。
- metadata blockのkeyと順序を固定する。
- Redmineでdescriptionが編集された場合、現在のdescriptionを正本とする。
- metadata blockが削除されてもcustom fieldsとcontext attachmentからthreadを識別する。
- Feedback UIはmetadata blockを折りたたみ、comment本文を主表示する。

### 11.4 locator custom field

locatorはpin/list表示に必要な最小情報だけをcompact JSONで格納する。

```json
{
  "v": "1",
  "location": {
    "schemaVersion": "1",
    "pageKey": "orders.detail",
    "routeTemplate": "/orders/{orderId}",
    "pathParameters": { "orderId": "sha256:..." },
    "queryParameters": {}
  },
  "target": {
    "schemaVersion": "1",
    "kind": "ui-element",
    "elementKey": "approve-button",
    "relativeX": 0.5,
    "relativeY": 0.5
  }
}
```

- `FeedbackLocationV1`と`FeedbackTargetV1`から、公開schemaで永続化を許可された値だけを含める。
- secret/PIIとしてhash指定されたparameterはhashのまま格納する。
- UTF-8 compact JSONで16 KiB以下とする。
- 16 KiBを超えた場合は投稿を`feedback.locator_too_large`で止め、切り捨てない。
- issue一覧responseにlocatorがない/壊れているthreadは一覧表示できるが、画面pinを表示しない。

### 11.5 context attachment

filenameを`feedback-context-v1.json`とし、完全な再構築情報を保存する。

```json
{
  "schemaVersion": "1",
  "kind": "feedback-context",
  "threadId": "uuid",
  "intentId": "uuid",
  "requestHash": "64 lowercase hex",
  "applicationKey": "inventory",
  "environmentKey": "production",
  "externalWorkspaceKey": "production-review",
  "pageKey": "orders.detail",
  "hostResourceKey": "opaque-resource-key",
  "release": "2026.08.19",
  "locale": "ja-JP",
  "perspectiveCode": "ux",
  "location": {},
  "target": {},
  "author": {
    "source": "host-session",
    "subjectId": "opaque-host-subject",
    "displayName": "User Name",
    "redmineUserId": null
  },
  "capturedAt": "2026-08-19T00:00:00Z",
  "primaryEvidence": {
    "filename": "feedback-{threadId}.png",
    "contentType": "image/png",
    "byteSize": 1234,
    "sha256": "64 lowercase hex",
    "viewportWidth": 1440,
    "viewportHeight": 900,
    "pixelRatio": 2,
    "capturedAt": "2026-08-19T00:00:00Z"
  }
}
```

- JSON Schemaは`contracts/feedback/schemas/redmine-feedback-context.schema.json`へ追加する。
- UTF-8、2 space indent、末尾LF 1文字で生成する。
- screenshotなしでは`primaryEvidence=null`。
- API key、browser history、access token、cookie、request headerを含めない。
- `author.source`は`host-session`または`redmine-api-key`。拡張機能版は`subjectId`をRedmine user ID文字列とし、
  `redmineUserId`へ同じnumeric IDを入れる。
- gatewayはclientから受け取ったauthor objectを破棄し、認証済みprincipalから再構築してからRedmineへuploadする。
- canonical `requestHash`はthread/intent ID、profile固定値、host resource key、location、target、perspective、comment、evidence SHA-256、
  trusted author subjectをkey順UTF-8 JSONへ正規化してSHA-256計算する。timestamp、表示名、Redmine issue IDはhash対象外とする。
- gateway/extension service workerがtrusted値注入後にhashを再計算し、custom fieldとcontextへ同じ値を保存する。
- retry回収時はthread ID、request hash、submittedBy ID、profile scopeがすべて一致する場合だけ既存issueを返す。不一致は本文を返さず409。

### 11.6 screenshot

- filenameは`feedback-{threadId}.png`または`.webp`。
- content typeはPNG/WebPだけ。
- 既存capture validationでdecode、dimension、byte sizeを検証する。
- browser memoryでSHA-256を計算しcontextへ入れる。gatewayは受信bytesから再計算し、client値と一致しなければ拒否する。
- trusted connectorがscreenshotとcontextを`POST /uploads.json?filename=...`へ個別uploadし、tokenをissue createの`uploads`へ渡す。
- upload tokenやbytesを永続保存しない。

### 11.7 reply・activity

- issue descriptionを最初のmessageとして表示する。
- `GET /issues/{id}.json?include=journals,attachments`のjournalsをID昇順で表示する。
- journal notesがnonblankならreplyとして表示する。
- journal detailsはstatus、assignee、priority、tracker、subject、description、attachment変更をactivity表示する。
- notesとdetailsを両方持つjournalはreplyとactivityの両方へ表示する。
- notesがRedmineで編集・削除された場合、次回fetchの現在値へ従う。Feedback側へ旧本文履歴を保持しない。
- Redmineが返すjournal author nameとcreated/updated timestampをそのまま使う。

## 12. 共通operation・gateway・extension contract

### 12.1 contract正本

次を`contracts/feedback`で同時にversion管理する。

- `redmine-operation.schema.json`: UIとtransport間の共通request/response DTO。
- `redmine-host-resource-ref.schema.json`: host resourceのclient reference。
- `redmine-gateway.openapi.yaml`: 埋め込み版gateway HTTP API。
- `redmine-extension-message.schema.json`: content/UIとservice worker間のmessage envelope。
- `redmine-feedback-context.schema.json`: Redmine attachmentへ永続化するcontext。

OpenAPI、生成TypeScript型、runtime validator、互換性文書を同じchangeで更新する。すべての境界でunknown propertyを拒否する。

### 12.2 共通operation

| type | payload | 用途 |
| --- | --- | --- |
| `redmine.profile.get.v1` | profile ID | 公開profile/capability取得 |
| `redmine.current-user.get.v1` | profile ID | 表示用current principal取得 |
| `redmine.thread.list.v1` | profile/resource ref/page/filter/cursor | issue一覧 |
| `redmine.thread.get.v1` | profile/resource ref/thread ID | 全journal/attachment詳細 |
| `redmine.thread.create.v1` | profile/resource ref/context/body/evidence/intent ID | 初回投稿 |
| `redmine.attachment.get.v1` | profile/resource ref/thread ID/attachment ID | preview/download |

`unlock`/`lock`/`diagnostic.download`は拡張機能固有、`markRead`/`follow`/`unread`はclient-state固有であり、
Redmine operation contractへ混在させない。

### 12.3 gateway HTTP mapping

base pathを`/internal/feedback-redmine/v1`とした場合の固定mappingは次とする。

| HTTP | path | 共通operation |
| --- | --- | --- |
| GET | `/profiles/{profileId}` | profile get |
| GET | `/profiles/{profileId}/me` | current user get |
| GET | `/profiles/{profileId}/threads` | thread list |
| GET | `/profiles/{profileId}/threads/{threadId}` | thread get |
| POST | `/profiles/{profileId}/threads` | thread create |
| GET | `/profiles/{profileId}/threads/{threadId}/attachments/{attachmentId}` | attachment get |

- createは`multipart/form-data`とし、`request` partにUTF-8 JSON、`evidence` partにoptional PNG/WebPを1件だけ受け付ける。
- gatewayはmultipart全体をstream処理し、diskへspoolしない。size上限を超えた時点で413にする。
- `Idempotency-Key`はintent UUID、body内thread IDもUUIDとする。gatewayはDBを持たず、14章のthread ID検索で冪等性を実現する。
- GET queryはschema定義済みpage/filter/sort/cursorだけを許可し、unknown queryを400にする。
- responseへ`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`を付ける。
- JSONは`application/json`、problemは`application/problem+json`、attachmentは検証済みcontent typeだけを返す。
- plugin fetchは`mode: "same-origin"`、`credentials: "same-origin"`を固定し、cross-origin gatewayを初版では許可しない。
- gatewayはCORS response headerを返さず、wildcard CORSを禁止する。
- create/uploadは認証済みhost session、gateway originとの完全一致`Origin`、`Sec-Fetch-Site: same-origin`、nonempty
  `X-Feedback-CSRF`をすべて必須にし、注入されたhost CSRF verifierでtokenを検証する。
- GETにもhost sessionと`Sec-Fetch-Site: same-origin`を要求する。同一origin GETではbrowserが`Origin`を省略するため、存在する場合は
  完全一致を検証し、省略自体は拒否しない。CSRF tokenはGETだけ省略できる。
- client abortをRedmine requestへ伝播し、client disconnect後もupload/createをbackground継続しない。

### 12.4 extension message mapping

- 共通operationを`{ contractVersion, requestId, type, payload }` envelopeへ入れる。
- `profile.unlock.v1`、`profile.lock.v1`、`diagnostic.download.v1`だけをextension固有operationとして追加する。
- service workerは`sender.id`が自extensionと一致することを確認する。
- content script requestはsender tab URLのoriginがprofile `hostOrigins`に含まれる場合だけ処理する。
- options page requestはextension originだけ許可する。
- message payloadのprofile IDからcredentialとRedmine URLを引き、payloadに任意URLを受け付けない。
- attachment IDとthread IDはRedmine responseから得た対応を現在のrequest内で再確認する。
- attachment bytesは`chrome.runtime.connect`の専用PortでJSON互換base64 chunkとして転送する。Blob/ArrayBufferの直接messageと
  Chrome 148以降のstructured-clone opt-inには依存しない。
- start messageはrequest ID、sanitized filename、content type、byte size、SHA-256、raw chunk size 196608、total chunksを持つ。
- chunk messageはrequest ID、0始まりindex、base64 data、complete messageはrequest IDを持つ。UIは順序、総byte数、SHA-256を
  検証後にだけ`Uint8Array`/Blob URLを生成する。
- Port disconnect/AbortSignalでservice workerのRedmine fetchを中断し、incomplete chunkをすべて破棄する。

### 12.5 gateway authorization・IDOR防止

- profile IDはserver allowlistに存在し、host principalがそのprofileのread/create権限を持つ場合だけ使う。
- gatewayは全operationで`authorizeResource(principal, operation, profile, resourceRef)` hookを呼び、認可済みopaque
  `hostResourceKey`を得る。client resource refや認可結果flagを信用しない。
- thread list/createはprofile固定project/tracker/application/environment/external workspace/pageと認可済みhost resource keyでfilterする。
- thread detailはthread UUID custom fieldで固定profile条件を指定して検索し、保存済みhost resource keyを別の
  `authorizeStoredResource` hookへ渡してからdescription/journalを返す。
- 検索結果が0件なら404、2件以上なら409。clientがRedmine issue IDだけを指定するAPIを設けない。
- attachmentはthread resource再認可後、thread detailのattachment集合にIDが含まれる場合だけ取得する。
- 他resourceの既知thread UUID、他threadのattachment ID、別resourceから流用したcursorは存在を漏らさず404にする。
- list cursorはprofile/resource/page/filter/sort/offsetだけを持つbase64url JSONとし、最大2 KiB、offset 0〜10000をruntime
  validationする。現在requestと全fieldが一致しなければ400にし、HMACや追加secretを使わない。
- service accountが見られる範囲より、host principalが見られる範囲を常に狭くできるようprofile authorizationを先に評価する。

### 12.6 error

```json
{
  "ok": false,
  "error": {
    "code": "redmine.permission_denied",
    "message": "日本語のsanitized detail",
    "retryable": false,
    "upstreamStatus": 403,
    "requestId": "uuid"
  }
}
```

- Redmine response body全文、API key、URL query、stack traceを返さない。
- plugin/content scriptはerror codeをUI文言へmappingし、raw HTMLを表示しない。

## 13. Redmine REST client

このclientはgateway serverとextension service workerだけから呼べるtrusted moduleとし、業務page bundleへexportしない。

### 13.1 使用endpoint

- `GET /users/current.json`
- `GET /projects/{projectId}.json`
- `GET /issues.json`
- `GET /issues/{issueId}.json?include=journals,attachments`
- `POST /uploads.json?filename=...`
- `POST /issues.json`
- `GET /attachments/{attachmentId}.json`
- attachment `content_url`

初回Feedback UIからissue更新を行わないため、`PUT /issues`、journal update、status update endpointは使用しない。

### 13.2 HTTP policy

- `Accept: application/json`を常に送る。
- POST JSONは`Content-Type: application/json`。
- uploadは`Content-Type: application/octet-stream`。
- API keyは`X-Redmine-API-Key`。
- redirect modeは`error`。
- metadata response上限は10 MiB。
- screenshot upload上限、inline preview上限、attachment download上限をprofileで別設定し、responseは該当上限とRedmine
  metadata sizeの小さい方に制限する。
- connect/headers timeout相当は15秒、issue create全体は60秒、attachmentは120秒でAbortControllerを使う。
- offline queueや自動background retryは行わない。
- GETだけ429/502/503/504を200ms、1sの最大2回retryする。
- upload/createはblind retryしない。必ずthread ID回収を先に行う。

### 13.3 URL policy

- request URLはprofile `redmineBaseUrl`と固定path segmentから組み立てる。
- arbitrary absolute URLをUI payloadから受け付けない。
- base URLがsubpathの場合はprefixを維持する。
- attachment `content_url`はuserinfo/query/fragment、encoded dot segment、backslashを拒否し、URL正規化後にbaseと同一
  scheme/host/portかつbase path prefix配下であることを確認する。redirectは拒否する。
- extensionではprivate/loopback networkを一律拒否せず、browser利用者が明示grantしたRedmine originを信頼境界とする。
- gatewayではserver profileに完全一致するoriginだけを許可し、DNS rebinding対策は顧客network policyへ従う。
- HTTPはdevelopment build以外拒否する。

### 13.4 pagination

- issue一覧は`limit=100`、offset paginationを最後まで辿る。
- 必ず`project_id`、`tracker_id`、`status_id=*`を指定する。
- application、environment、external workspace、page、host resource custom field filterを同時指定する。
- sortはUI選択に応じ`created_on:desc`、`created_on:asc`、`updated_on:desc`。
- plugin/extensionの1画面表示limitは50件とし、Redmine pageを内部で結合してcursor化する。
- cursorは12.5のprofile/resource/page/filter/sort/offsetを含むbase64url JSON。別queryへの再利用を拒否する。

### 13.5 response normalization

- Redmine unknown fieldは無視する。
- issue ID、subject、description、status、priority、author、created_on、updated_on、custom fieldsを必須validationする。
- exact status nameを主表示する。status `is_closed`がissueにない場合はopen/closed filter用途だけに限定し、normalized状態を推測表示しない。
- missing optional assignee/priority/attachmentはnull/空配列。
- malformed journalはissue全体を捨てず、そのjournalをerror activityとして表示しdiagnostic countを増やす。

## 14. 初回投稿

### 14.1 入力

- profile、host context、location、target、perspective、comment、optional screenshot。
- commentはtrim後1〜20,000文字。
- perspectiveはprofile定義内のcodeだけ。
- location/targetは既存公開schema v1へ適合すること。

### 14.2 pending intent

submit前に、埋め込み版はnamespaced `localStorage`、拡張機能版は`chrome.storage.local`へ次を保存する。

```json
{
  "schemaVersion": "1",
  "intentId": "uuid",
  "profileId": "inventory-production",
  "threadId": "uuid",
  "clientDraftHash": "sha256",
  "createdAt": "RFC3339",
  "state": "prepared | uncertain"
}
```

- comment、location、target、screenshot、API keyをintentへ含めない。
- `clientDraftHash`はtrusted author/resourceを含めず、form変更を端末内で検出するためのSHA-256である。Redmineへ保存する
  `requestHash`とは別物とする。
- 同じformのretryは同じintent/thread IDを使う。
- 利用者が内容を変更した場合は古いintentを明示破棄し、新thread IDを生成する。
- 成功時にintentを削除する。
- 7日経過したintentは起動時janitorで削除する。

### 14.3 sequence

1. plugin/content scriptで入力とcaptureをvalidationする。
2. thread UUIDとintentを生成・保存する。
3. 同じ端末でprofile/intent ID単位のin-flight mutexを取得し、二重clickと同時送信を止める。
4. 共通portへcreate requestを送る。埋め込み版はgateway、拡張機能版はservice workerが受ける。
5. trusted connectorはprofile、permission、current principal/resourceを確認し、clientのauthor/profile内部値をtrusted値で上書きして
   persisted `requestHash`を計算する。
6. profile固定project/tracker/application/environment/external workspace/host resourceと
   `cf_{threadIdFieldId}={threadId}&status_id=*`で既存issueを検索する。
7. 1件ならrequest hash、submittedBy ID、profile/resource scopeを照合し、そのissueを成功結果として返す。
8. 2件以上なら`redmine.duplicate_thread_id`で停止する。
9. 0件ならcontext JSONとoptional screenshotをuploadする。
10. upload tokenを含むissue JSONをPOSTする。
11. create後に同じ固定条件/thread IDでもう一度検索する。1件なら詳細を取得し、2件以上なら409で停止する。
12. custom fields、description metadata、attachment filename/hashを照合する。
13. 成功後にintentとdraftを削除し、drawerへ遷移してmutexを解放する。error/abort時も`finally`で解放する。

### 14.4 timeout・不明結果

- uploadまたはissue createのtimeout時はintentを`uncertain`にする。
- UIは「作成された可能性があります。同じ内容で再確認」を表示する。
- retryは必ず14.3 step 6のthread ID検索から始める。
- 回収issueのthread IDは一致するがcontext hashが異なる場合、`redmine.thread_mismatch`として自動採用しない。
- 別のthread IDで再投稿するbuttonを同じ画面へ出さない。利用者がintentを破棄した場合だけ新規投稿できる。

Redmine標準RESTとcustom fieldにはunique制約がないため、検索と作成の間に別gateway process/端末から同じthread IDのPOSTが並行すると、
2 issueが作られる可能性は残る。本計画の保証は「同一端末の二重送信抑止、blind retry禁止、逐次retryの既存issue回収、競合重複の
検知」であり、strict exactly-onceではない。strict uniquenessが将来必須なら、Redmine側unique制約/pluginまたはgateway永続
idempotency storeが必要になり、現在のDBレス・標準RESTのみという前提を変更する。

### 14.5 Redmine error

| Redmine/result | common code | UI |
| --- | --- | --- |
| 401 | `redmine.invalid_api_key` | profileをlockし再入力 |
| 403 | `redmine.permission_denied` | project権限確認 |
| 404 | `redmine.not_found` | profile ID確認 |
| 406 | `redmine.content_type_rejected` | connector defect扱い |
| 422 | `redmine.validation_failed` | Redmine validation messageをsanitize表示 |
| 429 | `redmine.rate_limited` | Retry-After後の手動retry |
| 5xx/network | `redmine.unavailable` | draft保持、手動retry |
| duplicate custom field | `redmine.duplicate_thread_id` | Redmine管理者へ連絡 |
| request hash/author/resource不一致 | `redmine.thread_mismatch` | 既存issue本文を表示せず管理者へ連絡 |

Redmine停止を特別運用しないが、draftと同じintentは端末内に残し、利用者の手動retryで重複を防ぐ。

## 15. thread一覧

### 15.1 現在画面の一覧

issue listを次でfilterする。

- project ID。
- tracker ID。
- status `*`。
- application key custom field。
- workspace key custom field。
- current page key custom field。

一覧responseにはdescriptionとcustom fieldsが含まれるため、追加detail requestなしで次を表示する。

- subject。
- metadata blockを除いた最初のcomment。
- exact status、priority、assignee。
- perspective。
- author、created/updated。
- locatorから復元したpin。
- attachment有無。previewはdetail取得後。

### 15.2 sort・filter

- sortは`created_desc`、`created_asc`、`updated_desc`。
- status filterはRedmine status IDまたは`open | closed`。
- perspectiveはcustom field filter。
- assignee/priorityはRedmine標準filter。
- `q`は一覧取得済みsubject/descriptionへclient-side適用する。
- 全journal本文を横断する全文検索は初版対象外とし、「Redmineで検索」へ遷移する。

### 15.3 最初と最新のcomment

- 最初のcommentを常に主表示する。
- 最新replyはvisible rowだけissue詳細をlazy loadして補助表示する。
- 1回にdetail取得するrowは最大10件、同時requestは4件。
- 画面内memory cacheは60秒で破棄し、browser storageへcomment本文を保存しない。
- detail取得前/失敗時も最初のcommentとstatusは一覧表示できる。

### 15.4 refresh

- 一覧を開いている間は60秒周期でissue listを再取得する。
- tabがhiddenの間は停止する。
- visibleへ戻ったら即時refreshする。
- polling timerはplugin drawer/listが閉じた時点、またはplugin `destroy()`時に解除する。

## 16. thread詳細・全やり取りの表示

### 16.1 取得

thread drawerを開くたびに次を呼ぶ。

```text
GET /issues/{issueId}.json?include=journals,attachments
```

このresponseから次を1つのtimelineへ構成する。

1. issue descriptionを最初のmessage。
2. journal notesを返信。
3. journal detailsをstatus/assignee/priority等のactivity。
4. issue attachmentsを証跡/添付一覧。

Redmine issue詳細が正本であり、Feedback側に返信cache DBは不要である。

ここで「全やり取り」とは、使用credentialに閲覧可能な全journal/attachmentを意味する。埋め込み版integration userに見えない
private noteをgatewayが表示することはできず、専用projectではprivate noteを使用しない。利用者別Redmine可視性を再現する必要が
ある場合は個人key resolverまたは拡張機能版を選ぶ。

### 16.2 更新

- drawerを開いている間は30秒周期で同じissue詳細を再取得する。
- tab hidden中は停止し、復帰時に即時取得する。
- `updated_on`とjournal ID/updated_onの組が変わらなければReact stateを更新しない。
- 新しいjournalがあればtimeline末尾へ追加し、aria-liveで通知する。
- Redmineでnotes編集・削除、status変更があれば次回responseの現在値へ置き換える。
- fetch失敗時は最後にmemory上で表示した内容を残し、「Redmineから再取得できません」を表示する。
- drawerを閉じるとbody/journal memory cacheを破棄する。

### 16.3 read-only UI

表示する。

- exact Redmine status。
- assignee、priority、tracker。
- 最初のcomment。
- 全replyとauthor/time。
- status/assignee/priority/subject/description/attachment activity。
- screenshotとその他attachment。
- `Redmineで開く`。

表示しない。

- reply input。
- message edit。
- resolve/reopen button。
- triage editor。
- reaction controls。

### 16.4 Redmine link

- gateway/extension trusted connectorがvalidated base URLとnumeric issue IDから生成したoptional URLだけを使う。
- 埋め込みprofileの`showRedmineLink=false`またはhost principalがRedmine UIを直接利用できない場合はlinkを表示しない。
- Redmine responseやdescriptionに含まれる任意URLをissue linkとして採用しない。
- `target=_blank`、`rel=noopener noreferrer`。

## 17. attachment・screenshot表示

### 17.1 metadata

- issue detailのattachmentsからID、filename、filesize、content type、author、created_onを表示する。
- `feedback-{threadId}.png|webp`とcontext metadataが一致するものをprimary evidenceとする。
- `feedback-context-v1.json`は通常UIでdownload候補に表示するがinline text表示しない。

### 17.2 download

1. UIはthread IDとattachment IDを共通portへ送る。
2. trusted connectorはprofile固定条件でthreadを再取得し、そのattachment IDがissueに属することを確認する。
3. `GET /attachments/{id}.json`でmetadataを確認する。
4. `content_url`のsame-origin/path policyを検証する。
5. trusted connectorがAPI key付きでbytesを取得する。
6. content type、declared size、actual sizeを照合する。
7. gatewayはbytesをno-store response、service workerは12.4のbase64 chunk PortとしてUIへ返し、UIがBlob URLを作る。

- Blob URLはdrawer closeまたは5分で`URL.revokeObjectURL`する。
- plugin/content scriptへraw API key/headerを渡さない。
- PNG/WebPだけinline previewし、SVG/HTML/PDF/office fileはdownloadのみ。
- filenameをDOM、path、Content-Disposition相当へ使う前にsanitizeする。
- gatewayはupstream `Content-Disposition`を転送せず、検証・sanitizeしたfilenameから自前で生成する。
- `X-Content-Type-Options`相当としてMIME sniffせず、declared/decoded image type一致を確認する。

## 18. 端末内未読badge

### 18.1 follow対象

- Feedback UIから作成したthreadは同じ端末で自動followする。
- 利用者がthread drawerで「このthreadを通知対象にする」を選んだ場合もfollowする。
- followは端末固有でRedmineへwatcher追加しない。
- unfollowしてもthread dataやRedmine issueを変更しない。

### 18.2 local state

埋め込み版のnamespaced `localStorage`または拡張機能版の`chrome.storage.local`へ、本文を含まない次だけを保存する。

```json
{
  "schemaVersion": "1",
  "profileId": "inventory-production",
  "principalScopeHash": "sha256",
  "threadId": "uuid",
  "issueId": 123,
  "followed": true,
  "lastSeenJournalId": 456,
  "seenJournalIds": [123, 456],
  "lastSeenIssueUpdatedOn": "RFC3339",
  "updatedAt": "RFC3339"
}
```

### 18.3 集計

- plugin mount時またはextension起動時、一覧refresh時、launcher/toolbar表示時にfollow中issueを最大100 IDずつ確認する。
- `updated_on <= lastSeenIssueUpdatedOn`ならdetailを取得しない。
- 更新されたissueだけdetailを取得し、`seenJournalIds`にない、かつnotesがnonblankのjournal件数を未読とする。
- 旧stateに`seenJournalIds`がない場合だけ`journal.id > lastSeenJournalId`で後方互換判定する。
- current host principalとRedmine user IDの検証済みmappingがある場合だけ、自身のjournalを未読件数から除外する。
- service account方式でmappingがない場合は全journal notesを未読として数え、誤って他者replyを除外しない。
- drawerを開いてtimeline描画成功後、最大journal ID、最大10,000件の既知journal ID、issue updated_onを既読として保存する。
- status変更だけのjournalはtoolbar返信badgeへ数えないが、drawer activityには表示する。
- plugin launcherまたはextension toolbar badgeはfollow中threadの未読reply合計。99超は`99+`。

### 18.4 制約

- 別端末・別browser profileと同期しない。
- site data削除、plugin storage namespace削除、extension再installで既読状態が失われることをUIへ明記する。
- Redmine側でjournalが削除されID gapが生じても、次の最大IDを使う。
- Redmine journal IDが単調増加しないfixtureを検出した場合はissue updated_on比較と既知ID集合へfallbackする。

## 19. browser storage詳細

### 19.1 埋め込みJavaScriptプラグイン

| storage | 保存するもの | 保存しないもの |
| --- | --- | --- |
| `localStorage` | pending intent hash、follow/read state | API key、送信済み本文、attachment bytes、gateway response body |
| `sessionStorage` | draft text、作成中metadata、一時detail cache | evidence bytes、永続業務data、API key |
| memory | evidence bytes、current profile/thread detail、Blob URL | page reload後に必要なdata |

- keyは`feedback.redmine.v1:{origin}:{profileId}:{principalScopeHash}:{kind}`形式でnamespace分離し、共有端末の利用者間で既読を混ぜない。
- `principalScopeHash`はgatewayが返すopaque host subjectまたはRedmine user IDをprofile IDとともにSHA-256した値とする。
- storage adapterを注入可能にし、業務appがstorage使用を禁止する場合はmemory-onlyへ差し替えられるようにする。
- local/session storage accessがSecurityErrorまたはquota errorの場合、投稿・閲覧を壊さずmemory-onlyへfallbackし、既読/draft非永続を表示する。
- pluginはhost appの既存storage keyを列挙・削除しない。`destroy()`でもfollow/read stateは保持し、明示`clearLocalState()`だけで削除する。
- local stateはUX専用であり、gateway/Redmine認可、thread/resource ownership、投稿者identityの根拠にしない。

### 19.2 拡張機能

| storage | 保存するもの | 保存しないもの |
| --- | --- | --- |
| `managed` | 非secret profile | API key、comment、screenshot |
| `local` | 非secret profile、pending intent hash、follow/read state | API key、送信済み本文、attachment bytes |
| `session` | API key、draft text、作成中metadata、一時detail cache | evidence bytes、永続業務data |
| service worker/UI memory | evidence bytes、attachment chunk | 永続業務data |
| content page storage | なし | すべて |

- content scriptから`storage.local/session`を直接読まず、service worker経由にする。
- `setAccessLevel(TRUSTED_CONTEXTS)`をlocal/sessionへ設定する。
- profile削除時は関連intent/follow/read state/session key/draftを削除する。
- extension uninstall後にRedmine dataは一切影響を受けない。

## 20. 接続設定・検証UI

### 20.1 埋め込み版setup順序

1. Redmine REST、project、tracker、custom field、integration userを準備する。
2. 顧客serverへgateway routeとsecretを設定する。
3. 業務app認証middleware、profile read/create authorization、CSRF protectionをgateway routeへ適用する。
4. `@feedback/redmine-plugin`をinstallまたはself-hosted ESM artifactを配置する。
5. host adapterとprofile IDでpluginをmountする。
6. non-mutating validationを行う。
7. canaryまたは実投稿でwriteを確認する。

### 20.2 拡張機能setup順序

1. profile JSON importまたはmanaged profile選択。
2. 業務画面origin permission付与。
3. Redmine origin permission付与。
4. 個人API key入力。
5. connection validation。
6. 対象業務画面でextension有効化。

### 20.3 non-mutating validation

通常の「接続確認」はRedmineへissueを作らず次を確認する。

- current principalとRedmine integration/current user取得。
- project取得。
- tracker指定のissue一覧read。
- 全必須custom field IDがissue responseで利用可能か。issueが0件ならここは`not yet proven` warning。
- 埋め込み版はsession/profile authorization/CSRF readiness、拡張機能版はhost permissionとHTTPS。

### 20.4 write validation

最初の実投稿前、または管理者が明示選択した場合だけcanary issueを作る。

- subjectは`[Feedback connection test] {UUID}`。
- private flag、全custom field、small context JSON attachmentを含める。
- thread ID filterで1件回収できることを確認する。
- canaryは削除せず、Redmine UIで管理する。
- write validationを未実施でも投稿buttonは押せるが、初回422の原因を設定画面へ案内する。

### 20.5 profile status

| state | 条件 | UI |
| --- | --- | --- |
| `permission-required` | host permissionなし | permission button |
| `locked` | API keyなし | key入力 |
| `unauthenticated` | 埋め込み版host sessionなし | 業務app login案内 |
| `profile-forbidden` | host principalにprofile権限なし | 管理者連絡 |
| `csrf-required` | create protection未設定 | 業務app設定error |
| `invalid-key` | current user 401 | key再入力 |
| `read-only` | list可、create 403/422 | 権限警告 |
| `ready` | validation成功 | 通常 |
| `error` | network/contract error | retry |

## 21. セキュリティ

### 21.1 credential

- 埋め込み版API keyはintegration user key、server-side only。拡張機能版は個人key、session-only、service worker-only。
- keyをlog、telemetry、error、DOM、URL、clipboard、source mapへ出さない。
- extension update時にkeyをmigrationしない。
- extensionのkey入力fieldはpassword type、autocomplete off、paste可、copy buttonなし。
- JavaScript plugin公開APIとTypeScript declarationにcredential fieldを一切定義しない。

### 21.2 host page・content script境界

- 埋め込み版はhost pageと同じtrust boundaryで実行されるため、業務appのXSSがplugin操作を実行できることを明記する。gateway認証・認可・
  CSRF・固定operation validationをbrowser外の最終防御にする。
- extensionのpage scriptとcontent script間はwindow messageを使わず、既存host adapterの明示APIだけを使う。
- 必要な場合もrandom channel IDとJSON Schema validationを必須にする。
- host pageからRedmine operation type、URL、headerを指定させない。
- React rootはShadow DOMへmountし、host CSSとの干渉を避ける。Shadow DOMはhost scriptからのsecurity boundaryではない。

### 21.3 XSS

- Redmine subject/description/notes/name/filenameをHTMLとして挿入しない。
- formatting preview初版ではplain textとする。
- linkificationは`https`だけ、sanitized URLだけ。
- extension CSPと配布exampleの業務app CSPから`unsafe-eval`、remote script、inline scriptを除く。
- dependency artifactへSubresource Integrityは適用できないため、bundleへ固定しlockfileを検証する。

### 21.4 screenshot/privacy

- capture前にpreviewを必ず表示する。
- 利用者が明示submitするまでRedmineへuploadしない。
- profileごとにcapture無効化可能。
- host adapterのredaction ruleをcapture前に適用する。
- incognito/private browsingでは端末stateをmemory-onlyにする。extensionは既定無効とする。

### 21.5 permission最小化

- `<all_urls>`、`tabs`、`webRequest`、cookie permissionを要求しない。
- `activeTab`、`scripting`、`storage`と選択originだけ。
- attachment requestにもcookieを使わずAPI keyだけ。
- optional permission拒否時は該当profileだけ無効にする。

### 21.6 gateway hardening

- same-origin relative routeだけをpluginから呼ぶ。gatewayはCORSを有効化せず、`Access-Control-Allow-Origin: *`を返さない。
- request body、multipart part数、filename、content type、decoded image dimension、response sizeに上限を設ける。
- authentication前にRedmineへrequestしない。authorization失敗時にprofile/project/thread存在有無を漏らさない。
- service account permissionをFeedback projectの閲覧・issue追加・attachment追加へ限定する。
- reverse proxy/application serverのaccess logからquery、cookie、request bodyを除外し、API key headerを常にredactする。
- outbound redirectを拒否し、Redmine base URL以外へcredentialを送らない。
- gateway processのfilesystemはread-onlyを推奨し、upload一時fileを作らない。

## 22. Redmineが完全な正本であることの検証

threadをRedmineだけから次の順で再構築できることをcontract testにする。

1. project/tracker/application/environment/external workspace/page/host resource filterでissueを列挙する。
2. custom fieldからthread UUID、page、perspective、locatorを得る。
3. descriptionから初回commentを得る。
4. journalsから全replyとfield activityを得る。
5. attachmentsからcontext JSONとscreenshotを得る。
6. context JSONから完全なlocation/target/evidence metadataを得る。

埋め込み版のsite dataまたはextension local storageを空にしても、profileと有効な接続経路があれば1〜6を再現できることを
受入条件にする。
失われてよいのは端末固有の既読/follow/draftだけである。

## 23. 証跡・Export

### 23.1 Feedback側では実装しないもの

- Export job API。
- CSV/XLSX/evidence-package生成worker。
- Export object storage。
- Feedback audit CSV。
- Feedback backup/retention policy。

### 23.2 Redmine側へ委ねるもの

- issue一覧Export。
- issue history/journal。
- attachment原本。
- Redmine backupとretention。
- Power BIからのRedmine REST/API datasource接続。

Redmine標準の一覧Exportが全journalやattachment bytesを単一fileに含めるとは限らない。しかし正本はRedmineにあるため、
Feedback Systemが複製を持つ必要はない。将来「commentsと全attachmentを単一証跡ZIPにする」要件が復活した場合は、
Redmineからその場で取得してbrowser内で生成する任意機能として別計画にし、server DB/storageは導入しない。

## 24. 既存データの一度限り移行

### 24.1 runtimeとの分離

- 既存Feedback DBにproduction dataがない場合、migration CLIを実行しない。
- dataがある場合だけ`feedback-redmine-migrate` one-shot CLIを提供する。
- CLIはruntime extensionへ同梱しない。
- CLI終了後にFeedback DB接続情報とmigration API keyを破棄する。

### 24.2 migration入力

- 旧Feedback PostgreSQL read-only connection。
- 旧private object storage read-only credential。
- destination Redmine URL/project/tracker/custom field mapping。
- migration専用Redmine service account API key。
- application/environment/external workspaceごとのserver/extension profile。

### 24.3 mapping

- 旧thread UUIDを`Feedback Thread ID`へそのまま使う。
- 最初のmessageをdescription、残りをjournal notesへ移す。
- 元author/time/message IDを各migration note footerへ記録する。
- current status/priority/assigneeを可能な範囲でRedmine fieldへmappingする。
- location/targetをlocator/contextへ保存する。
- evidenceをattachmentへuploadする。
- reactionは移行しない。
- 編集履歴や旧triage履歴が必要な場合は`feedback-history-v1.json` attachmentへ保存するが、Feedback UIの正本表示には使用しない。

### 24.4 idempotency

- issue作成前にthread ID custom fieldで検索する。
- migration note footerの旧message IDで重複を検出する。
- thread IDが2件、message markerが2件なら停止する。
- CLI progress fileはmigration作業用であり、最終正本ではない。

### 24.5 verification

全threadについて次をRedmineから再取得して確認する。

- thread UUID/custom fields。
- description current body hash。
- reply count/message marker/body hash。
- status/priority mapping。
- context/history attachment hash。
- evidence attachment SHA-256。

1件でも不一致なら旧DBを廃止しない。全件一致reportとRedmine backupを取得した後にのみ旧Feedback runtimeを停止できる。

## 25. error表示とdiagnostic

### 25.1 利用者向け

- API key invalid。
- project access denied。
- profile/custom field invalid。
- Redmineへ接続できない。
- issueが削除された/見つからない。
- attachmentが削除された/取得できない。
- thread ID重複。
- response contract不正。

detailは行動可能な日本語にし、Redmine raw errorをそのまま表示しない。

### 25.2 local diagnostic

- request ID、operation、profile ID、HTTP status、duration、error codeをmemory ring buffer最大100件へ保持する。
- profile ID以外のbusiness key、host principal、issue body、journal、filename、API keyを含めない。
- pluginはpage reload、extensionはbrowser再起動で消去する。
- 利用者が明示downloadするdiagnostic JSONにもsecret/business bodyを含めない。

### 25.3 telemetry

初版はremote telemetryを送信しない。central serverを持たないため、利用状況・errorをFeedback管理先へ外部収集しない。
顧客gatewayの標準HTTP metricはstatus/latency/operation/profile IDだけに限定し、body、thread ID、principal、API keyをlabel/logへ入れない。

## 26. 実装deliverableとfile mapping

### 26.1 公開contract

担当workstreamは次だけを変更する。

- `contracts/feedback/redmine-gateway.openapi.yaml`
- `contracts/feedback/schemas/redmine-client-profile.schema.json`
- `contracts/feedback/schemas/redmine-host-resource-ref.schema.json`
- `contracts/feedback/schemas/redmine-extension-profile.schema.json`
- `contracts/feedback/schemas/redmine-operation.schema.json`
- `contracts/feedback/schemas/redmine-extension-message.schema.json`
- `contracts/feedback/schemas/redmine-feedback-context.schema.json`
- migration実装時だけ`contracts/feedback/schemas/redmine-feedback-history.schema.json`
- `contracts/feedback/src/redmine-gateway.generated.ts`
- `contracts/feedback/src/index.ts`
- `contracts/feedback/src/schema.test.ts`
- `contracts/feedback/package.json`
- `contracts/feedback/README.md`
- `contracts/feedback/CHANGELOG.md`

既存`contracts/feedback/openapi.yaml`はlegacy Feedback Serviceのcontractとして維持する。Redmine gateway APIを混在させず、別OpenAPIを
正本にする。既存`contracts/feedback/src/generated.ts`、`freeze-v1.json`、Go contract生成物は変更しない。生成型を手書きだけで済ませず、
Redmine専用`redmine-gateway.generated.ts`とschema/OpenAPIとのdrift testを追加する。

### 26.2 共通Redmine core

新規workspace `packages/feedback-redmine-core`を追加する。

```text
packages/feedback-redmine-core/
  package.json
  tsconfig.json
  tsconfig.build.json
  README.md
  CHANGELOG.md
  src/index.ts
  src/port.ts
  src/model.ts
  src/profile.ts
  src/redmine-client.ts
  src/redmine-dto.ts
  src/normalize.ts
  src/context.ts
  src/subject.ts
  src/marker.ts
  src/pagination.ts
  src/errors.ts
  src/client-state.ts
  src/host-adapter.ts
  src/*.test.ts
```

- DOM、React、Chrome API、Node filesystem、process environmentへ依存しないpure TypeScriptにする。
- networkはconstructor injectionしたfetch interfaceだけを使う。
- Redmine requestを作るtrusted connector APIと、UIが使う`RedmineFeedbackPort`を別exportにする。
- API keyを受けるconstructor/APIは`./trusted` subpathに隔離し、plugin browser entryからbundleされないことをbuild testにする。
- `FeedbackRedmineHostAdapter`を9.2どおり定義し、既存`FeedbackHostAdapter`へ変更を要求しない。
- `@feedback/contracts`のRedmine専用生成型、`@feedback/core`のhost/evidence typeだけへ依存する。

### 26.3 共通React UI

新規workspace `packages/feedback-redmine-react`を追加する。

```text
packages/feedback-redmine-react/
  src/provider.tsx
  src/overlay.tsx
  src/thread-list.tsx
  src/thread-drawer.tsx
  src/capture.ts
  src/storage.ts
  src/styles.css
  src/*.test.tsx
```

- `packages/feedback-react`が既に公開する`createDomEvidenceProvider`を再利用し、既存`FeedbackProvider`、`FeedbackOverlay`、
  `FeedbackTransport`へ変更を加えない。既存overlayはservice固有機能へ密結合しているため共用しない。
- Redmine UIは最初の投稿だけwrite可能、thread detailはread-onlyとし、reply/edit/status/reaction controlをDOMへrenderしない。
- UIは`RedmineFeedbackPort`と`ClientStatePort`だけへ依存する。

### 26.4 埋め込みJavaScriptプラグイン

新規workspace `packages/feedback-redmine-plugin`を追加する。

```text
packages/feedback-redmine-plugin/
  src/index.ts
  src/gateway-transport.ts
  src/storage.ts
  src/mount.tsx
  src/validation.ts
  src/*.test.ts
  vite.config.ts
  README.md
  CHANGELOG.md
tests/fixtures/feedback-redmine-plugin-vanilla/
  index.html
  src/main.ts
  package.json
```

- `createRedmineFeedbackPlugin(options)`とhandleを9.2どおりexportする。
- ESM packageとsingle self-hosted ESM bundleをbuildする。bundleにReact runtimeを含めるvariant名を明示する。
- gatewayはrelative same-origin base path以外を拒否し、`mode/credentials: "same-origin"`、必須CSRF callback、no-storeを実装する。
- vanilla fixtureをconsumer build/testへ追加し、React frameworkをhostへ要求しないことを証明する。

### 26.5 stateless gateway library・reference

新規workspace `packages/feedback-redmine-gateway`へ再利用可能なhandlerを置く。

```text
packages/feedback-redmine-gateway/
  src/handler.ts
  src/auth.ts
  src/authorization.ts
  src/profile.ts
  src/csrf.ts
  src/redmine.ts
  src/multipart.ts
  src/problem.ts
  src/*.test.ts
  package.json
  README.md
  CHANGELOG.md
```

新規workspace `apps/feedback-redmine-gateway-reference`を追加する。

```text
apps/feedback-redmine-gateway-reference/
  src/server.ts
  src/session-adapter.ts
  src/config.ts
  src/*.test.ts
  package.json
  Dockerfile
  README.md
```

- gateway packageはWeb標準`Request`/`Response`に近いhandlerへ、`authenticate`、`authorizeResource`、
  `authorizeStoredResource`、`loadProfile`、`loadSecret`、`fetch`を注入する。
- sample serverはproduction用dummy authenticationを提供しない。test fixtureだけが固定principalを使う。
- 起動に必要なsecretがなければfail-fastし、secret既定値を実装しない。
- gateway package/referenceともDB driver、ORM、queue、disk upload、cache dependencyを追加しない。
- Docker imageはnon-root、read-only root filesystemで実行可能にする。
- 顧客がNode以外でgatewayを実装できるよう、READMEはOpenAPI準拠要件とsecurity checklistを主にし、reference実装を必須にしない。

### 26.6 Chrome / Edge拡張機能

新規workspace `apps/feedback-redmine-extension`を追加する。

```text
apps/feedback-redmine-extension/
  manifest.json
  src/background/index.ts
  src/background/credential-vault.ts
  src/background/message-handler.ts
  src/content/index.tsx
  src/content/host-bridge.ts
  src/options/index.tsx
  src/storage/chrome-storage.ts
  src/*.test.ts
  public/
  vite.config.ts
  README.md
```

- Manifest V3、optional host permission、programmatic content script registration、session credentialを実装する。
- 共通React UIとRedmine coreを使い、gateway/UI logicをcopyしない。
- Chrome APIを薄いadapterの外へ漏らさず、unit testではfake chrome APIを注入する。
- unpacked directoryとstore提出用ZIPをdeterministicに生成する。署名やstore uploadは実装scope外とする。

### 26.7 root・検証・文書

主エージェントだけが次のshared hotspotを変更する。

- root `package.json` / `package-lock.json`
- `scripts/verify-feedback.sh`
- `scripts/check-feedback-contracts.sh`
- `scripts/check-feedback-packages.sh`
- `scripts/check-feedback-redmine-packages.sh`
- `scripts/check-feedback-redmine-security.sh`
- `scripts/check-feedback-redmine-conformance.sh`
- 必要なら`tests/fixtures/feedback-sdk-vite/**`
- `docs/environment-variables.md`
- `docs/redmine-integration.md`
- `docs/redmine-gateway.md`
- `docs/redmine-extension.md`
- `docs/redmine-migration-and-decommission.md`
- `docs/api-compatibility.md`
- `docs/release.md`
- root `README.md`

root build順はcontracts、core、React UI、plugin、gateway library/reference、extension、既存package/appとする。
`scripts/check-feedback-contracts.sh`の既存`projectId`混入checkはlegacy生成型だけを対象にし、Redmine専用生成型の正当な
`projectId`を明示除外する。`scripts/verify-feedback.sh`は各新workspaceの
typecheck/test/build、schema/OpenAPI lint、consumer fixture、manifest validation、bundle secret scan、既存全検証をskipなしで実行する。

### 26.8 local Redmine Docker E2E harness

userは最終E2EのためにDocker Official Image `redmine`をlocalへpull・起動することを許可している。recorded fixtureだけで
Redmine互換性を合格にせず、次を追加する。

```text
deploy/redmine-conformance/compose.yaml
tests/redmine-conformance/images.lock.json
tests/redmine-conformance/seed/
tests/redmine-conformance/src/
tests/redmine-conformance/run-local-matrix.sh
tests/redmine-conformance/README.md
```

- 初期version pinは`redmine:5.1.12-bookworm`、`redmine:6.0.10-bookworm`、`redmine:6.1.3-bookworm`、
  `redmine:7.0.0-bookworm`とし、実装時にDocker Hub manifestを確認してdigestまで`images.lock.json`へ固定する。
- floating `latest`、major tagだけのpin、非公式imageを使わない。tag/digest更新は専用review changeにする。
- Redmine 5.1 imageがregistryから取得不能ならtestをskip/successにせず、対応floor変更または再現可能な公式image archive方針をuserへ確認する。
- 各versionはSQLite fallbackを使うthrow-away containerとし、production相当DBや既存local Redmineへ接続しない。
- container、network、tmpfs/volume、compose projectへ`feedback-redmine-e2e-{runId}`label/nameを付け、既存container/volumeを操作しない。
- portはloopback `127.0.0.1`のephemeral portだけへbindし、LANへ公開しない。
- versionごとに新規empty storageを使い、Rails runner seedでREST有効化、dedicated project/tracker/role/integration user/custom fields、
  個人key user、issue/journal/attachment fixtureを作る。
- seedで生成したtest API keyは一時directoryのmode 0600 fileまたはprocess memoryだけに置き、log/artifactへ出さない。
- testはprofile validation、issue create、upload、list/sort/filter、detailの全journal/activity、attachment download、resource IDOR、
  timeout retry、Redmine-only reconstructionを実APIで行う。
- matrixはresource競合を避けるため既定serial実行とし、各version終了時にcompose `down --volumes --remove-orphans`相当をtrapで行う。
- cleanup対象はrun IDとcompose labelが一致するtest resourceだけに限定する。失敗時も既存Docker resourceを削除しない。
- network pullがsandboxで拒否された場合は、主エージェントが`docker pull redmine:<exact-tag>`相当を承認付きで再実行する。
- 公式image仕様と現在のtagは[Docker Official Image: redmine](https://hub.docker.com/_/redmine)および
  [docker-library/redmine](https://github.com/docker-library/redmine)を正本として確認する。

### 26.9 one-shot migrationの条件分岐

- `/goal`開始時にproduction DBへ勝手に接続しない。
- userが既存dataの存在とmigration実装をscopeへ明示した場合だけ`tools/feedback-redmine-migrate/**`を追加する。
- 明示されていない場合はruntime/plugin/gateway/extensionの完成を妨げず、migration runbookとcontractだけを整備する。
- migration agentを起動する場合の所有pathは`tools/feedback-redmine-migrate/**`とmigration専用testだけに限定する。

## 27. `/goal`実行時のサブエージェント運用指令

### 27.1 terminal objective

このfileをgoalへ指定された主エージェントは、「計画を要約する」ことではなく、26章の必須deliverableを実装し、29章の受入条件を
すべて満たすことをobjectiveとする。途中Phaseの完了、buildだけの成功、未実装TODOを残した状態でgoalをcompleteにしない。
default goal scopeはW0〜W8であり、W9 migration CLIとproduction migration実行は含めない。userがgoal指示でmigration実装を
明示した場合だけW9を追加する。local Docker Official Redmine E2Eはdefault scopeに含む。

開始直後に必ず行う。

1. repository rootの`AGENTS.md`とこの文書を全文読む。
2. `git status --short`、current branch、直近commitを記録し、既存user変更を保護する。
3. `bash scripts/verify-feedback.sh`をbaseline実行する。既存failureならlogと今回scopeの関係を切り分ける。
4. 実装planを27.4のworkstream単位で登録し、最大1件だけ`in_progress`にする。
5. 利用可能な並列slotから主エージェントを除いたslotを、依存関係が解けたworkstreamへ割り当てる。
6. 各sub-agentへ27.3の共通promptと排他的ownershipを渡す。

### 27.2 shared worktreeの競合防止

全agentは同じfilesystem/worktreeを共有すると仮定する。

- sub-agentは指定された所有path以外を編集しない。
- sub-agentは`git add`、`git commit`、`git switch`、`git rebase`、`git reset`、`git clean`、`npm install`を実行しない。
- root `package.json`、`package-lock.json`、verify script、legacy生成型、共通docsは主エージェントだけが編集する。
- contract agentだけが`contracts/feedback/src/redmine-gateway.generated.ts`を編集・生成する。他agentは生成型をread-onlyで使う。
- dependency追加が必要なsub-agentはpackage固有`package.json`へ希望を記述して主エージェントへ報告し、lockfile更新を待つ。
- formatter/codegenをrepository全体へ実行しない。所有pathだけをtargetにする。
- 他agentの途中変更を戻さない。ownership外のdefectを見つけたら主エージェントへfile/line/期待修正を報告する。
- 各agentは自身のtestを通してからhandoffするが、全体verify成功を主張しない。
- 同じfileがどうしても必要なworkstreamは並列実行せず、先行agent完了後にfollow-up taskとして順次編集する。

### 27.3 sub-agent共通prompt template

主エージェントは次を具体値で埋めて渡す。

```text
目的: <workstreamの完成条件>
先に読む: repository AGENTS.md、docs/redmine-system-of-record-plan.mdの<section>
変更可能: <排他的path list>
変更禁止: root package.json、package-lock.json、scripts/verify-feedback.sh、他workstream path
依存artifact: <contract version / export / fixture>
実装要件: <MUST項目>
検証command: <package限定command>
禁止: commit、push、branch変更、全体npm install、所有外file修正
handoff: changed files、実装結果、検証結果、残課題、主agentに必要なshared変更を日本語で返す
```

agentが曖昧な設計判断を必要とした場合は勝手に公開contractを変えず、主エージェントへ選択肢と推奨を送る。主エージェントはこの文書の
確定事項から決められるものを即決し、業務要件を変えるものだけuserへ確認する。

### 27.4 workstream DAG・agent割当

```text
W0 baseline / shared scaffold（主agent）
  |
  v
W1 public contracts（contract agent）
  |
  v
W2 common Redmine core（core agent）
  |-----------------------+-----------------------+
  v                       v                       v
W3 React UI/plugin      W4 gateway reference    W5 extension skeleton
  |                       |                       |
  +-----------------------+-----------------------+
                          v
                 W6 extension UI wiring
                          |
                +---------+---------+
                v                   v
       W7A Redmine Docker E2E   W7B browser/security E2E
                +---------+---------+
                          v
              W8 integration/docs/verification（主agent）
                          |
                 [明示scope時だけ]
                          v
                    W9 migration CLI
```

| ID | 主担当 | 開始条件 | 排他的所有path | 完了artifact |
| --- | --- | --- | --- | --- |
| W0 | 主agent | 即時 | shared hotspot | baseline記録、workspace directory scaffold方針 |
| W1 | contract agent | W0 | 26.1のpath | schema/OpenAPI/generated型/test、compat docs用change request |
| W2 | core agent | W1型確定 | `packages/feedback-redmine-core/**` | port、Redmine client、normalizer、unit test |
| W3 | UI/plugin agent | W2 public export確定 | `packages/feedback-redmine-react/**`、`packages/feedback-redmine-plugin/**`、vanilla fixture | framework非依存mountと共通UI |
| W4 | gateway agent | W1、W2 trusted export確定 | `packages/feedback-redmine-gateway/**`、`apps/feedback-redmine-gateway-reference/**` | stateless handler、security/test、Dockerfile |
| W5 | extension agent | W1後。W2/W3待ち部分はstub interfaceまで | `apps/feedback-redmine-extension/**` | manifest/options/storage/message skeleton |
| W6 | extension agent follow-up | W2、W3完了 | `apps/feedback-redmine-extension/**` | 共通UI/core wiring、package build/E2E |
| W7A | Redmine E2E agent | W3/W4/W6 | `tests/redmine-conformance/**`、`deploy/redmine-conformance/**` | 公式image matrix、seed、実REST再構築E2E |
| W7B | browser/security agent | W3/W4/W6 | `tests/redmine-browser-e2e/**`、`tests/redmine-security/**` | plugin/extension E2E、security fixture |
| W8 | 主agent | W7A/W7B | 26.7のshared hotspot | lockfile、scripts、docs、full verify、差分review |
| W9 | migration agent | user明示 + W2 | `tools/feedback-redmine-migrate/**` | one-shot CLI、resume/verify test |

W1とW2は公開shapeの再workを防ぐため直列にする。W2完了後はW3/W4/W5を最大3 agentで並列化する。W5がW3のUIを必要とする部分は
compile可能なadapter boundaryまでに留め、W6で同じextension agentへfollow-upする。新agentに引き継がせずcontextを維持する。
product code gate後にW7A/W7Bを並列化し、主エージェントはその間にshared docs/script差分を準備するが、両E2Eの所有pathを編集しない。

### 27.5 handoff gate

各sub-agentの完了通知を受けた主エージェントは、次へ進む前に必ず行う。

1. `git diff -- <ownership paths>`でscope逸脱とsecret混入を確認する。
2. agent報告のtest commandを主エージェント側でも再実行する。
3. public export、error code、schema version、filenameが本計画と一致するか確認する。
4. `TODO`、`FIXME`、`throw new Error("not implemented")`、skip test、empty handlerを検索する。
5. defectがあれば同じagentへ具体的なfollow-up taskを返し、主エージェントが大規模に書き直さない。
6. gate通過後にだけ依存workstreamを開始する。

### 27.6 commit・push policy

- sub-agentはcommitしない。主エージェントがgate通過後に明示pathをstageする。
- commit単位は`C1 contract`、`C2 core`、`C3 plugin UI`、`C4 gateway`、`C5 extension`、`C6 E2E`、
  `C7 integration/docs`を基本とする。
- 各commit messageは日本語とし、commit前にその単位のtestを再実行する。
- userの既存変更をcommitへ混ぜない。shared fileに既存変更がある場合はdiffを読んで共存させる。
- remote push、PR作成、release/store upload、deploymentはgoalに明示された場合だけ行う。
- goalが実装だけを求める場合はverified working treeまたはlocal commitsまでで完了し、勝手に外部stateを変えない。

### 27.7 blocker・停止条件

- package downloadやDocker image取得がsandbox/networkで失敗した場合は、同じ必要commandを承認付きで再実行する。
- userは26.8の公式Redmine imageをlocalへpull/start/stop/removeしてE2Eすることを明示許可済みである。実行時toolが追加承認を
  要求する場合だけ、その承認flowに従う。
- production Redmineや顧客host auth実装がなくても、local Docker Official Imageとreference session adapterでE2Eを完了できるためblockerにしない。
- store signing keyがなくてもunpacked/ZIP artifactまで完了できるためblockerにしない。
- user choiceが必要なのは、service account方式を禁止してRedmine author厳密一致を埋め込み版でも要求する場合、既存production data migration、
  顧客固有authentication middlewareをrepositoryへ直接実装する場合だけとする。
- 未検証、部分実装、時間不足をsuccessとして扱わない。goalのblock判定は同じ阻害条件が規定回数継続し、safeな代替検証も尽きた場合だけ行う。

## 28. 実装・テストmilestone

### 28.1 M1 contract gate

- 全新規schemaのvalid/invalid fixture。
- Redmine gateway OpenAPI lint。
- OpenAPI operationと`redmine-operation` DTOの対応test。
- profileへAPI key、absolute gateway URL、unknown fieldを入れた場合の拒否test。
- generated TypeScript型のcompile test。
- existing `contracts/feedback/openapi.yaml` freeze/behavior testが無変更で成功する。

### 28.2 M2 core gate

- subject Unicode truncation、metadata block/parser、locator/context deterministic JSON/hash。
- Redmine DTO unknown/missing/malformed field、journal notes/activity normalization。
- issue list offset/limit/filter/status/sort、cursor query binding。
- filename/content URL/XSS sanitize、redirect拒否、subpath base URL。
- 401/403/404/406/413/422/429/5xx/timeoutのproblem mapping。
- GETだけretry、POST blind retryなし、thread ID検索0/1/2件。
- upload token + issue create、逐次timeout retryの既存issue回収、並行作成時の重複検知fake Redmine test。
- attachment issue membershipとsame-origin/path検証。
- packageのbrowser entryへNode built-inやcredential APIが混入しないbuild check。

### 28.3 M3 plugin/UI gate

- vanilla hostへのShadow DOM mount、二重mount拒否、冪等destroy、timer/listener/Blob URL cleanup。
- relative same-origin gateway pathだけ許可し、absolute/protocol-relative/dot segmentを拒否する。
- `mode/credentials: "same-origin"`、必須CSRF header、AbortSignal、problem mapping。
- initial-post-only説明、最初のcomment主表示、最新reply補助表示。
- created asc/desc、updated desc、status/perspective filter。
- description、全journal notes、field activity、attachmentのread-only timeline。
- reply/edit/status/triage/reaction controlがDOMに存在しない。
- drawer 30秒/list 60秒poll、document hidden停止、復帰時即refresh。
- screenshot preview/consent/redaction、safe attachment preview/download。
- local follow/read/mark-read/99+、storage unavailable時memory fallback。
- host CSP下で`unsafe-eval`、inline/remote scriptなしで動作するconsumer build test。

### 28.4 M4 gateway gate

- authentication未実行/失敗時にRedmine fetchが0回。
- read/create別resource authorization、profile allowlist、client指定project/author/resource認可結果無視。
- sessionなし、Origin不一致、`Sec-Fetch-Site`不一致、`X-Feedback-CSRF`欠落/不正、unknown query/body/multipart partを拒否。
  POSTはOrigin必須、GETはbrowserによる省略を許すが、存在するOriginの不一致は拒否する。
- CORS headerとcross-origin gateway routeが存在しない。
- thread UUID + profile/host resource固定fieldでのIDOR防止、stored resource再認可、attachment membership再確認。
- request/response size、decoded image、content type、redirect、timeout上限。
- API keyがheader以外、problem、log、response、source mapへ出ない。
- handlerがDB/filesystem/queue/cacheを使わず、upload bytesをstream処理する。
- service account authorとhost principal metadataが11章どおりRedmineへ保存される。
- Docker imageをnon-root/read-onlyで起動できる。

### 28.5 M5 extension gate

- sender origin/profile validation、任意URL operation拒否。
- content scriptからcredentialを取得できず、keyが`chrome.storage.session`だけに存在する。
- browser再起動相当でlock、401でlock、redirectへkeyを送らない。
- optional host permissionとprogrammatic registration。
- 共通plugin/UIと同じthread list/detail/create/attachment/未読contract test suiteをadapter差替えで通す。
- manifest permission allowlist、extension CSP、remote scriptなし、bundle secret scan。
- Chrome headlessでcontent script/options/service worker smoke。Edgeは同じChromium artifactのmanifest/build互換test。

### 28.6 M6 Redmine conformance・再構築gate

- 26.8のdigest固定Docker Official Imageをlocalに実起動し、Redmine 5.1.12、6.0.10、6.1.3、7.0.0をserial検証する。
- issue description、全journal notes、field-only journal、notes+field journal、edited/blank notes、attachmentsを確認する。
- plugin site dataとextension local storageを空にし、Redmineだけからthread/location/evidenceを再構築する。
- gateway経路とextension経路が同じnormalized thread fixtureを返すgolden testを持つ。
- recorded fixture testもunit regressionとして維持するが、Docker実REST matrixの代替にしない。image取得・起動・seed・testのどれかが
  未完ならM6未達とし、goalをsuccess扱いしない。

### 28.7 M7 repository final gate

1. 各workspaceのtypecheck/test/build。
2. consumer fixture build/test。
3. schema/OpenAPI/generated drift check。
4. extension manifest/security/bundle scan。
5. local Docker Official Redmine 4-version matrix。
6. `rg`によるTODO/FIXME/secret/default key/legacy Feedback API依存scan。
7. `git diff --check`。
8. `bash scripts/verify-feedback.sh`をskip変数なしで実行。
9. `git status --short`と`git diff --stat`を確認し、計画外変更がない。

## 29. 最終受入条件

### 29.1 architecture

1. 埋め込みJavaScriptプラグインを業務appのbundleまたはself-hosted ESMとして利用でき、browser拡張installを必要としない。
2. Chrome / Edge拡張機能も同じUI、port、Redmine schemaで利用できる。
3. runtimeはFeedback PostgreSQL、object storage、host DB、sync worker、server-side cacheを使用しない。
4. stateless gatewayにDB driver、ORM、queue、persistent cache、attachment storageがない。
5. Redmine issue/journal/attachment/custom fieldsだけから全業務dataを再構築できる。

### 29.2 authentication・security

6. Feedback独自OIDC、token exchange、membership DBを追加しない。
7. 埋め込み版は業務app既存sessionとauthorizationを使い、Redmine keyをbrowserへ一度も返さない。
8. gatewayはsame-origin、CSRF、operation/profile allowlist、host resource authorization、thread/attachment ownershipを検証する。
9. gateway integration keyはsecret必須かつ既定値なし、拡張機能個人keyはsession storageだけに存在する。
10. clientがRedmine URL、project/tracker/custom field ID、author、HTTP header/methodをoverrideできない。
11. service account方式では認証済みhost principalがcustom field/contextへ、拡張機能方式ではRedmine userがauthor/contextへ記録される。

### 29.3 behavior

12. Feedback UIから初回comment、context、optional screenshotをRedmine issueへ作成できる。
13. blind retryを行わず、通常の逐次timeout retryは既存issueへ収束し、並行競合で2件を検出した場合は409でfail-closedする。
14. 最初のcommentを一覧の主表示、最新replyを補助表示にし、3種のsortを選べる。
15. 使用credentialに見えるissue description、全journal notes、field details、attachmentsをFeedback drawerで参照できる。
16. Redmineで追加したreply/status/assignee/priorityが開いたdrawerへ30秒以内に表示される。
17. Feedback UIにreply/edit/status/triage/reaction操作が存在しない。
18. 端末内未読badgeがfollow threadの新規replyを数え、複数端末同期を要求しない。
19. Redmine停止中のoffline受付/queue/central availability monitoringを実装しない。
20. Feedback独自Export、audit、backup、retentionを実装しない。

### 29.4 quality

21. 公開API/DTO変更とOpenAPI、生成型、compatibility文書が一致する。
22. plugin vanilla consumer、gateway security、extension Chrome smoke、digest固定Docker Official ImageによるRedmine 5.1.12/6.0.10/
    6.1.3/7.0.0 conformance/reconstruction testが成功する。
23. source/bundle/log/test fixtureにAPI keyやsecret既定値がない。
24. `git diff --check`が成功する。
25. `bash scripts/verify-feedback.sh`がskip変数なしで成功する。

## 30. 配布・運用

### 30.1 配布物

- `@feedback/redmine-core` package。
- `@feedback/redmine-react` packageとCSS。
- `@feedback/redmine-plugin` ESM package、self-hosted bundle、TypeScript declaration。
- stateless gateway OpenAPI、Node reference app、Docker image source。
- Chrome/Edge unpacked directory、enterprise/store用ZIP。
- managed policy schema/sample。sampleにAPI keyを含めない。
- Redmine custom field/setup、gateway組込、plugin組込、extension installation guide。

### 30.2 埋め込み版の利用開始

1. Redmine REST、project/tracker/custom field、integration userを準備する。
2. gatewayを業務appの既存認証middleware配下へmountする。
3. Redmine URL/profile mapping/secretをserverへ設定する。
4. read/create authorizationとCSRFを設定する。
5. pluginを業務appへimportし、host adapter/profile IDでmountする。
6. read validation、canaryまたは実投稿、全thread表示を確認する。

### 30.3 拡張機能版の利用開始

1. Redmine RESTとproject/custom fieldを準備する。
2. extensionをinstallする。
3. profileをmanaged policyまたはoptionsから設定する。
4. 業務画面/Redmine origin permissionを許可する。
5. 個人API keyをsessionへ入力する。
6. read validationと実投稿を確認する。

### 30.4 key rotation

- 埋め込み版はsecret manager/server環境でintegration user keyを入れ替え、gateway processを安全にreloadする。
- 拡張機能版は利用者がRedmineでkeyを再生成し、profileをlockして新keyをsessionへ入力する。
- old keyをFeedback DB、browser永続storage、migration fileへ保持しない。

### 30.5 Redmine backup

- issue/journal/attachmentが唯一の正本なので、Redmine DB/filesのbackupとrestore試験を運用必須にする。
- Feedback plugin、gateway、extensionはbackup成功を監視しない。
- Redmine retentionでattachmentやjournalを削除した場合、Feedback UIからも次回取得時に消える。

## 31. 旧管理型計画から削除するもの

次は本方針では実装しない。

- `Redmine Record Adapter`、`feedback-redmine-worker`。
- workspace binding DBと状態機械。
- create intent DB、external record mapping DB、projection table、sync cursor。
- Feedback OIDC/token exchange/membership。
- server-side polling/cache/TTL、migration/cutover/rollback/purge API。
- Feedback evidence/Export/Backup storage。
- centralized metric/alert/audit。
- Azure上のFeedback API/DB/worker deployment。
- JavaScriptへ埋め込むRedmine API keyとCORSによる直接接続。

置き換えるものは共通Redmine port/UI、埋め込みJavaScriptプラグイン、顧客side stateless gateway、Manifest V3拡張機能、Redmine
custom fields、端末内pending intent/read state、必要時だけのone-shot migration CLIである。

## 32. 配備時に入力する値

### 32.1 埋め込みclient

- profile ID。
- same-origin gateway base path。
- host adapter。
- optional message override、必須CSRF token getter。

Redmine URL、API key、project/tracker/custom field IDをclientへ渡さない。

### 32.2 gateway server

- Redmine base URL。
- integration user API keyのsecret reference。既定値なし。
- profile IDからproject/tracker/default priority/custom field IDへのmapping。
- application/environment/external workspace/perspective/capture上限。
- 業務app principalからprofile read/create権限へのpredicate。
- host principalのopaque ID/display name抽出policy。
- timeout/body/attachment上限。

Node reference appの環境変数は次へ固定し、`docs/environment-variables.md`にsecret/non-secret、必須性、rotationを記載する。

- `FEEDBACK_REDMINE_GATEWAY_PROFILE_FILE`: server profile JSONのabsolute path。必須、非secret。
- `FEEDBACK_REDMINE_GATEWAY_API_KEY`: integration user key。必須secret、既定値なし。
- `FEEDBACK_REDMINE_GATEWAY_SESSION_SECRET`: reference appのsigned test/demo session用。reference appだけ必須secret、既定値なし。

顧客組込時はgateway libraryへhost principal/secret/profile resolverを直接注入でき、上記環境変数名の採用を強制しない。

### 32.3 extension

- application/environment/external workspace key、業務画面origin、Redmine base URL。
- project/tracker/default priority/custom field ID。
- perspective、capture上限。
- 利用者個人Redmine API key。sessionへ都度入力する。

これら以外のruntime DB/storage/worker設定を追加しない。新しい永続化要件が発生した場合は、Redmineへ保存できるかを先に検討し、
安易にFeedback DBを再導入しない。
