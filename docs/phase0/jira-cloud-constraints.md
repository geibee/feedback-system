# Jira Cloud Phase 0 制約調査

確認日: 2026-08-31

## 対象と調査方法

初期Connectorの対象は **Jira Cloud** に限定する。Jira Data CenterのREST API、認証、property実装を同じConnectorの条件分岐で扱わない。本調査はJira Cloud platform REST API v3とForgeの公式資料だけを根拠とし、test tenantへのwriteは行っていない。

以下では、公式資料に明記された事実と、公開request契約に保証が見当たらないため保守的に置く判断を分ける。fixtureはlive responseの記録ではなく、契約検討用の合成反例である。

## Phase 0で固定する判断

- issue作成の`POST /rest/api/3/issue`はrequest bodyに`properties`を受ける。したがって、`threadId`、`intentId`、`requestHash`を一つのissue propertyへまとめ、issue作成と同じ最初のprovider requestへ載せることは可能である。
- ただし、Create issueの説明は単一issue作成とproperty設定全体を「transactional」と明記していない。同一requestに載せられることと、あらゆる障害時にissueとpropertyが不可分にcommitされることは区別し、後者はlive確認まで保証しない。
- 任意のissue propertyが自動的にJQL検索可能になるわけではない。`threadId`等を完全一致検索するには、インストール済みForge appの`jira:entityProperty` module等で対象pathを`string`としてindex定義する必要がある。
- JQL enhanced searchは既定でread-after-write整合ではない。公式資料は遅延を数秒から数分とし、上限を契約していない。`reconcileIssues`は既知のissue IDを最大50件渡す仕組みなので、create response喪失によりissue IDも不明な場合の`threadId`検索missを解消しない。
- JQL/propertyは一意制約ではない。0件は即時の不存在証明にせず`pending`、2件以上は`repair_required`とし、自動選択または新規作成を行わない。1件でも署名済みEnvelope、provider binding、scope、現在の認可を検証するまで採用しない。
- comment作成と更新は、それぞれbodyと`properties`を同じrequestへ載せられる。一方、Forgeの`jira:entityProperty` index対象entity typeにはcommentが含まれず、確認したcomment property APIにもproperty横断検索はない。reply／revision回収は、既知のissue配下のcommentをpaginationし、markerまたはcomment propertyを検証する設計候補とする。
- attachment追加はissueに対する独立した`multipart/form-data` requestであり、公開request契約に`attachmentId`、`intentId`、entity property、idempotency keyはない。結果不明時に同じbinaryを自動再uploadせず、初期分類を`best-effort`とする。
- issue／comment propertyは機密storeでも認可境界でもない。編集権限を持つ利用者と他appから変更でき、global namespaceでlast-write-winsであるため、検索projectionは候補抽出だけに使い、署名済みEnvelopeの検証を必須とする。

## API別の制約

### issue作成とissue property

Jira Cloud REST API v3のCreate issueは`IssueUpdateDetails.properties: EntityProperty[]`を受け、説明にもissue propertiesを設定できるとある。Phase 0の候補requestは次の形とする。

```json
{
  "fields": {
    "project": { "key": "FB" },
    "issuetype": { "id": "10001" },
    "summary": "Feedback"
  },
  "properties": [
    {
      "key": "com.geibee.feedback.recovery.v2",
      "value": {
        "threadId": "0191f34b-3a4e-7f61-8ba4-1f4f96774919",
        "intentId": "74cb2662-2467-43f4-a506-bebc65e45e8c",
        "requestHash": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
      }
    }
  ]
}
```

property単独のreadは`GET /rest/api/3/issue/{issueIdOrKey}/properties/{propertyKey}`、writeは`PUT`である。単独writeにはBrowse projectsとEdit issuesが必要だが、Create issue自体の文書上のproject permissionはBrowse projectsとCreate issuesである。作成時同梱propertyに追加のEdit issuesが必要かはlive tenantで確認する。

Entity propertyには次の制約がある。

- keyは最大255 bytes、valueは有効なJSONで最大32768 bytes。
- entityを編集できる利用者と全appが変更可能で、keyはglobal namespaceにある。
- per-user sandboxではなく、同一propertyの同時編集を調停する仕組みはなく、最後に保存された値が残る。
- 個人情報、secret、認可判断に使う情報を信頼可能な平文として保存しない。

### propertyのJQL検索、index遅延、一意性

Forgeの`jira:entityProperty` moduleはissue propertyの指定pathをindexする。`threadId`、`intentId`、`requestHash`はtokenizeされる`text`ではなく、`=`による完全一致が可能な`string`を使用する。JQLは次を候補とする。

```text
project = "FB"
AND issue.property['com.geibee.feedback.recovery.v2'].threadId =
  "0191f34b-3a4e-7f61-8ba4-1f4f96774919"
```

property keyとpathのindex定義はConnectorの暗黙の前提にせず、provider profileのprovisioning／readiness項目にする。index moduleがないtenantでは、propertyを直接readできても`threadId`からissueを再解決できないため、DBレスConnectorの最低条件を満たさない。

Enhanced searchの公式制約は次のとおりである。

- recent updateは検索結果へ直ちに現れない場合がある。
- 遅延は数秒から数分で、操作により変動する。
- `reconcileIssues`は最大50件で、指定したissueだけに整合性を強化する。
- RESTの推奨手順はwrite responseからissue IDを得て、そのIDを`reconcileIssues`へ渡すものである。

したがって、create responseが失われた経路ではissue IDがなく、JQLの0件を「作成されなかった」と判定できない。公開資料にはthread propertyの一意制約もないため、Connectorは検索結果を次のように扱う。

| 検索結果 | 判定 | 禁止事項 |
| --- | --- | --- |
| 0件 | `pending` | 自動再作成、`not_found`の即時返却 |
| 1件 | Envelope等を検証後に`completed`候補 | projectionだけで返却 |
| 2件以上 | `repair_required` | 先頭／最新issueの自動選択 |
| JQL field未定義 | profile／Connector設定不備 | 全issue走査による常用fallback |

なお、検索結果の可視性は呼出主体のBrowse projects、issue-level security、app access ruleにも依存する。権限不足による非表示と不存在を混同しない。

### comment、comment property、revision

`POST /rest/api/3/issue/{issueIdOrKey}/comment`と`PUT /rest/api/3/issue/{issueIdOrKey}/comment/{id}`はいずれもrequest bodyに`body`と`properties`を受ける。これにより、replyまたはcomment更新型revisionの本文と`messageId`／`eventId`、`intentId`、`requestHash`を同じprovider requestへ載せる候補を作れる。

ただし、次は静的資料だけでは確定しない。

- response喪失直後のcomment一覧／property直接readの可視性。
- comment一覧responseにpropertyが常に含まれるか、comment IDごとのproperty GETが必要か。
- 同じ`intentId`を持つcommentが複数作られた場合の運用上の修復方法。
- update request内のbodyとpropertiesについて、障害時の不可分commitが保証されるか。
- concurrent update用のversion／ETag／条件付き更新契約。Entity property自体はlast-write-winsである。

Forgeの`jira:entityProperty` moduleが列挙するentity typeはissue、user、projectであり、commentは含まれない。初期設計ではglobalなcomment property検索を仮定せず、既知のthreadに対応するissueからcommentをpaginationし、署名markerまたはpropertyを検証する。本文中markerを併用する場合も、本文の検索結果だけを正本にしない。

### attachment

`POST /rest/api/3/issue/{issueIdOrKey}/attachments`は一つ以上のfileを受ける。multipart field名は`file`、`X-Atlassian-Token: no-check` headerが必須で、成功時はAttachment配列を返す。`GET /rest/api/3/attachment/meta`からtenantの有効／無効と`uploadLimit`を取得できる。

公開request契約にはFeedback側の`attachmentId`／`intentId`、attachment property、content hash、idempotency keyを同じuploadへ保存する欄がない。また、複数file uploadのtransactional保証も明記されていない。このため次を固定する。

- 一つのFeedback upload commandにつきproviderへ送るfileは一つとし、複数fileの原子性を仮定しない。
- attachmentのFeedback metadataをissue propertyやcommentへ後続writeする場合、binary uploadとは別操作でありpartial writeになり得る。
- upload成功後にresponseが失われ、provider attachment IDが不明な場合は`repair_required`とする。
- filename、size、author、created timestampだけで既存attachmentを一意に採用しない。
- 結果不明のbinary bodyを自動再送しない。利用者が明示的に再送する場合も同じ`intentId`を維持し、重複可能性を通知する。
- attachment有効状態と上限はprofile capabilityとして起動時／適切なrefresh時に取得するが、正本cacheとして永続化しない。
- JiraのCreate attachments permission／OAuth scopeを満たしていても、Feedback Service側では独立した`feedback:attachment:upload`権限を必須とする。create／reply権限から暗黙に導出しない。

attachmentの同名file重複可否と、複数file requestの部分成功挙動は公開資料から断定せず、live確認項目に残す。

## 暫定保証水準

| 操作 | Phase 0暫定分類 | 根拠と残課題 |
| --- | --- | --- |
| create | 要live確認（`recoverable`候補） | 最初のCreate issue requestへ3 recovery値を同梱可能。ただしresponse喪失時はissue IDがなく`reconcileIssues`を使えず、JQL遅延上限と一意制約もない。 |
| reply | 要live確認（`recoverable`候補） | comment本文とpropertyを同じPOSTへ同梱可能。既知issue配下を走査できるが、timeout直後の可視性とproperty取得経路を確認する必要がある。 |
| revision | 要live確認（`recoverable`候補） | 既知comment IDへのPUTで本文とpropertyを同梱可能。body/propertyの障害時commitと競合制御を確認する必要がある。append型revisionならreplyと同じ制約になる。 |
| attachment upload | `best-effort` | upload requestへstable ID／intent markerを同梱する公開契約がなく、結果不明時に一意回収できない。自動再uploadしない。 |

live確認完了前にcreate／reply／revisionを`recoverable` capabilityとして公開しない。`exactly-once`、不変監査、provider障害中のoffline readはどの分類でも保証しない。

## permission、scope、API version

対象APIはJira Cloud platform REST API **v3**（`/rest/api/3`）である。v3はcomment body、issue description等にAtlassian Document Formatを使用する。以下は公式endpoint文書の最小project permissionとOAuth 2.0 scopeである。classic scopeはAtlassianの推奨値を記す。

| 操作 | project permission／visibility | classic scope | 主なgranular scope |
| --- | --- | --- | --- |
| Create issue + properties | Browse projects、Create issues | `write:jira-work` | `write:issue:jira`、`write:comment:jira`、`write:comment.property:jira`、`write:attachment:jira`、`read:issue:jira` |
| Issue property read | Browse projects、issue-level security | `read:jira-work` | `read:issue.property:jira` |
| Issue property write | Browse projects、Edit issues、issue-level security | `write:jira-work` | `write:issue.property:jira` |
| JQL enhanced search | Browse projects、issue-level security | `read:jira-work` | `read:issue-details:jira`、`read:field.default-value:jira`、`read:field.option:jira`、`read:field:jira`、`read:group:jira` |
| Add comment | Browse projects、Add comments、issue/comment visibility | `write:jira-work` | `read:comment:jira`、`read:comment.property:jira`、`read:group:jira`、`read:project:jira`、`read:project-role:jira`、`read:user:jira`、`write:comment:jira`、`read:avatar:jira` |
| Update comment | Browse projects、Edit own commentsまたはEdit all comments、visibility | `write:jira-work` | `read:comment:jira`、`read:comment.property:jira`、`read:group:jira`、`read:project:jira`、`read:project-role:jira`、`read:user:jira`、`write:comment:jira`、`read:avatar:jira` |
| Comment property read/write | readはBrowse projectsとvisibility、writeはEdit own/all comments | `read:jira-work`／`write:jira-work` | `read:comment.property:jira`／`write:comment.property:jira` |
| Add attachment | Browse projects、Create attachments、issue-level security | `write:jira-work` | `read:user:jira`、`write:attachment:jira`、`read:attachment:jira`、`read:avatar:jira` |
| Attachment settings | project permissionなし | `read:jira-work` | `read:instance-configuration:jira` |

実装時は選択した認証方式についてendpoint文書のgranular scope集合を再生成／再確認し、単一の広いscope表から推測しない。Jira側permissionとFeedback ServiceのAuthorization Mode、server profile policy、backend capabilityの積集合を取る。

Jira Cloudはquota、burst、per-issue writeのrate limitを持ち、超過時は429と`Retry-After`を返す。既知の429はheaderに従って扱うが、response自体を受け取れなかったwriteをrate-limit retryと同一視して盲目的に再送しない。

## 反例fixture

`tests/fixtures/jira-cloud-phase0`に次を置く。

- `create-issue-with-properties.json`: 最初のissue作成requestへ3 recovery値を同梱する候補。
- `thread-search-miss.json`: create直後のJQL 0件を`pending`とする反例。
- `thread-search-multiple-hits.json`: 同一`threadId`が2 issueに存在し、自動選択できない反例。
- `thread-search-unindexed.json`: propertyは存在してもindex moduleがなく、thread ID検索不能な反例。
- `comment-create-with-properties.json`: reply本文とintent markerを同じcomment POSTへ載せる候補。
- `comment-intent-multiple-hits.json`: 同じintentを持つcommentが複数あり、自動選択できない反例。
- `revision-update-with-properties.json`: comment更新型revisionの候補と競合未解決を固定するfixture。
- `attachment-result-unknown.json`: response喪失後、provider markerがなく一意回収できない反例。

すべて合成fixtureであり、tenant URL、credential、実在account IDを含まない。

## live確認に必要な権限と操作

Phase 2で管理されたJira Cloud test tenantを使う場合、次が必要である。

### 準備権限

- test tenantへForge appをinstallできる管理権限。`com.geibee.feedback.recovery.v2`の`threadId`、`intentId`、`requestHash`を`string` indexする`jira:entityProperty` moduleを宣言する。
- 専用test projectに対するBrowse projects、Create issues、Edit issues、Add comments、Edit own commentsまたはEdit all comments、Create attachments。
- test cleanupを行う場合だけDelete issues、Delete own/all comments、Delete own/all attachmentsを追加する。
- OAuth 2.0は上表のclassic `read:jira-work`、`write:jira-work`、または各endpointに必要なgranular scopeの和集合を使う。

### 具体的なlive操作

1. `POST /rest/api/3/issue`でissue本文と3 recovery値入りpropertyを同送し、issueとpropertyの往復を確認する。
2. 作成直後にpropertyの完全一致JQLを実行し、通常検索の遅延を計測する。issue ID既知時は`reconcileIssues`あり／なしを比較する。
3. upstreamがrequestを受理した後にclient側でresponseを破棄するfault injectionを行い、issue ID不明の状態からproperty JQLだけで回収できる時間と0件時の挙動を確認する。自動再作成はしない。
4. 同じ`threadId`を持つtest issueを意図的に2件作り、複数hitが`repair_required`になることを確認する。
5. comment bodyとpropertyを同じPOSTへ送り、response喪失後にcomment paginationとcomment property GETだけで一意回収できるか確認する。
6. 既知commentをbodyとrevision property付きで更新し、response喪失後の直接read、競合更新、marker不一致を確認する。
7. `GET /rest/api/3/attachment/meta`のenabled／uploadLimitを取得し、一つのfileをuploadする。response喪失を発生させた後は再uploadせず、一覧metadataだけで一意回収できないことを確認する。
8. 別のcleanup可能なtest issueで同名fileの2回uploadと複数file requestの部分失敗を確認し、重複可否とatomicityを匿名化fixtureへ記録する。

このPhase 0では上記writeを実行していない。

## 公式資料

すべて2026-08-31確認。

- [Jira Cloud REST API v3 About / Version](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/)
- [Jira Cloud REST API v3 Issues](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/)
- [Jira Cloud REST API v3 Issue properties](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-properties/)
- [Jira entity properties](https://developer.atlassian.com/cloud/jira/platform/jira-entity-properties/)
- [Forge jira:entityProperty module](https://developer.atlassian.com/platform/forge/manifest-reference/modules/jira-entity-property/)
- [Jira Cloud REST API v3 Issue search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)
- [Search After Write with Search And Reconcile](https://developer.atlassian.com/cloud/jira/platform/search-and-reconcile/)
- [Jira Cloud REST API v3 Issue comments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/)
- [Jira Cloud REST API v3 Issue comment properties](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comment-properties/)
- [Jira Cloud REST API v3 Issue attachments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-attachments/)
- [Jira Cloud rate limiting](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/)
