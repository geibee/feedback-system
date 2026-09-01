# ADR 0004: 公開契約の正本、package境界、v1／v2 security boundary

- 状態: 採用
- 決定日: 2026-08-31
- 適用範囲: Phase 1以降の契約作成と並列実装

## 文脈

現行公開型はRedmine v1 OpenAPIに由来し、browser DTOへ`issueId`、`journalId`、`redmineUrl`等が露出している。汎用v2を既存package内の手書き型として並行追加すると、型の正本とsecurity boundaryがconsumerごとに分岐する。後続Phaseをshared fileの競合なしに並列化できる所有境界が必要である。

## 決定

### 公開契約の正本

公開契約の唯一の正本を`contracts/feedback`に固定する。

| 契約 | 正本 | 備考 |
| --- | --- | --- |
| Redmine gateway v1 HTTP | `contracts/feedback/redmine-gateway.openapi.yaml` | 移行期間中は互換維持し、汎用fieldへ直接置換しない |
| v1 JSON保存／runtime契約 | `contracts/feedback/schemas/redmine-*.schema.json` | unknown property拒否を維持する |
| 汎用v2 HTTP | Phase 1で追加する`contracts/feedback/feedback-gateway.openapi.yaml` | base pathは`/internal/feedback/v2` |
| v2 domain／Envelope／profile schema | Phase 1で追加する`contracts/feedback/schemas/feedback-*.schema.json` | provider名をschema名とbrowser DTOへ含めない |
| 生成TypeScript型 | 各OpenAPIから生成する`contracts/feedback/src/*.generated.ts` | 手編集せずdrift検査する |
| release差分 | `contracts/feedback/CHANGELOG.md`と`docs/api-compatibility.md` | API／DTO変更と同じ変更で更新する |

OpenAPI／JSON Schemaから生成できる概念をconsumer packageへ手書きで複製しない。APIまたはDTOを変更する場合、OpenAPI、JSON Schema、生成型、contract test、互換性文書、CHANGELOGを同じ変更で更新する。設定を追加する場合は`docs/environment-variables.md`も更新し、secretに既定値を設けない。

### server内部とbrowserの境界

- provider key、object ID、event ID、canonical URL、REST DTO、credential、field IDはConnector／server内部だけで扱う。server-only `ProviderRef`はPhase 1の`packages/feedback-connector-sdk`に置き、OpenAPI component、browser package、rendererからexportしない。
- browserはFeedback stable IDである`threadId`、`messageId`、`eventId`、`attachmentId`だけを受け取る。外部画面への移動はprovider URLではなく、認可付きsame-origin navigation pathを返す。
- ticket本文、会話、証跡、操作回復metadataの正本はproviderであり、wire DTO、browser storage、projection、in-process cacheを正本としない。

### v1／v2 security boundary

- v1は`/internal/feedback-redmine/v1`、v2は`/internal/feedback/v2`へ別々にmountする。path rewriteで相互fallbackしない。
- Feedback Serviceへ収容したv1 facadeとv2は、同じserver profile IDに固定された同じAuthorization Modeを通る。modeはprofileの起動時設定で一意であり、request header、query、path、token欠落による切替を拒否する。
- `signed-grant`／`remote-authorization` profileのv1 facadeを`public-profile`として公開しない。同じprofile IDを複数modeで同時mountしない。
- legacy standalone `apps/feedback-redmine-gateway-reference`は現行配備との互換のため残し、その公開participant modeをv2の`public-profile`相当として文書化する。v1 participant credentialは実在人物認証へ昇格させない。
- v2 readerはvalidなv2 Envelopeを優先する。v2 metadataが存在しないticketだけをlegacy readerへ渡し、invalid v2をlegacy値で上書きまたは隠蔽しない。
- v1 APIと既存`@geibee/feedback-redmine-*` packageは、代替package、移行文書、利用状況確認、告知期間を伴う将来のmajor変更まで維持する。Phase 0〜2で削除、rename、export縮小を行わない。

### Phase 1で固定するpackage名と依存方向

Phase 1の単一integration作業で次のcontract／skeletonを作成し、それ以前に本番consumerを実装しない。

```text
renderer -> @geibee/feedback-controller
         -> @geibee/feedback-client
         -> @geibee/feedback-contracts / @geibee/feedback-core

service HTTP -> @geibee/feedback-gateway
             -> @geibee/feedback-connector-sdk
             -> @geibee/feedback-contracts / @geibee/feedback-core

connector -> @geibee/feedback-connector-sdk + @geibee/feedback-envelope
```

追加するpackage名は`@geibee/feedback-client`、`@geibee/feedback-connector-sdk`、`@geibee/feedback-envelope`、`@geibee/feedback-gateway`、`@geibee/feedback-controller`、`@geibee/feedback-web-component`、`@geibee/feedback-react`、`@geibee/feedback-connector-redmine`、`@geibee/feedback-connector-jira-cloud`、app名は`apps/feedback-service`に固定する。

generic packageからRedmine、Jira、React、DOM、provider HTTP clientへ依存しない。rendererからConnector、Connectorからbrowser packageへ依存しない。既存Redmine packageへの接続変更は契約freezeとlane完了後の直列integrationで行う。

### 共有fileの所有

integration ownerだけが次を最終編集する。

- root `package.json`、lockfile、workspace／CI設定
- `contracts/feedback/**`、生成型、共通CHANGELOG、互換性文書
- `scripts/verify-feedback.sh`とrelease script
- package skeletonと依存DAG

並列laneは割り当てられたpackage、専用fixture、専用testだけを編集する。shared contract不足を見つけたlaneは、契約を直接変更せず、最小反例fixture、差分案、consumer影響をintegration ownerへ返す。正規`bash scripts/verify-feedback.sh`、生成、lockfile更新、最終mergeは直列に行う。

## 却下した選択肢

- v1 OpenAPIをその場で汎用化する: 既存consumerとsecurity boundaryを破壊するため採用しない。
- provider内部参照をopaque stringとしてbrowserへ返す: opaqueでもIDORとprovider binding漏洩を防げないため採用しない。
- 各packageに似たport型を手書きする: 並列laneで意味論が分岐するため採用しない。
- v1 facadeだけ認可を省略する: v2認可の迂回路になるため採用しない。

## 帰結

Phase 1のshared contract draftができるまで、Connector、Feedback Service、controller、rendererの本実装を開始しない。v1 characterizationと互換台帳はv1 facadeおよび移行readerのacceptance baselineとして使用する。
