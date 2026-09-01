# Hard Gate 1 実行記録

判定日: 2026-08-31

対象commit: `cc78a3f18c7a3fa5f6054f7f562de20bc11da156`上の未commit Phase 0／Phase 1変更

## 判定

**Hard Gate 1: PASS**

Phase 1の公開契約draft、全package skeleton、依存DAG、生成型、設定schema、環境変数文書までを実装した。Phase 2のfake port、TCK、Envelope codec、Jira Cloud contract spike、本番Connector、外部tenant writeは開始していない。

| 完了条件 | 判定 | 根拠 |
| --- | --- | --- |
| 全consumerが参照する型の正本が一つに決まっている | PASS | 公開契約を`contracts/feedback`へ集約し、browser v2を`@geibee/feedback-contracts/v2`、server-only生成型を`@geibee/feedback-contracts/v2/server`から公開した。package内の手書きinterfaceは実装portに限定した |
| package DAGに循環がなく、generic packageへRedmine、Jira、React、DOM依存が入っていない | PASS | `scripts/check-feedback-phase1.sh`が全workspaceの依存graphを検査し、Phase 1 packageのexact dependencyとpure generic source／生成declarationの禁止依存を検査した |
| root共有ファイルを並列laneが編集しなくてよい状態になっている | PASS | 全package directory／manifest／entry point、root workspace／script、lockfile、生成入口、provider profile／service settings schema、環境変数文書をintegration ownerが追加した |
| contract-only buildとgolden fixture testが成功する | PASS | 11個のPhase 1 workspaceについてtypecheck、test、buildが成功し、controller snapshot golden、安定ordering／unread、request hash、認可／upload／projection／recoveryの反例fixtureを検証した |

## 固定した契約境界

- workspace／resource discoveryはprofile policy、Authorization Mode decision、backend capabilityの積集合を超えず、provider内部IDをbrowserへ公開しない。
- attachment uploadは独立した`feedback:attachment:upload`権限を要求し、結果不明時のbinary自動再送を禁止する。
- create、reply、revision、attachment uploadは操作ごとに`recoverable`、`best-effort`、`unsupported`を宣言し、結果不明をtypedなHTTP 202 recoveryへ正規化する。
- projectionは候補抽出専用とし、Envelope schema／署名、provider binding、scope、現在の認可、profile policy、backend capabilityを順に検証するまで返却しない。
- `ProviderRef`はConnector SDKのserver-only実装portとし、OpenAPI、client、controller、rendererへ漏らさない。
- Feedback Service skeletonはDB、queue、persistent／shared application data cache、upload directory、private object storage、host DB直接参照を持たない。

詳細は[`contract-freeze-candidates.md`](./contract-freeze-candidates.md)を正本候補台帳とする。

## Phase 1 scoped検証

| command／対象 | 結果 |
| --- | --- |
| `bash scripts/check-feedback-common-contracts.sh` | PASS。v1／v2 OpenAPIと全JSON Schema生成型のdrift、Spectral lintを検査 |
| `bash scripts/check-feedback-phase1.sh` | PASS。必須成果物、全workspace DAG、禁止依存、DBレス境界、公開export、fixture、生成型、typecheck／test／buildを検査 |
| `npm run build:all` | PASS。既存RedmineとPhase 1 skeletonを依存順にbuild |
| `@geibee/feedback-contracts` test | 21 tests PASS。v1を維持しつつv2の公開／server境界、権限、recovery、profile、fixtureを検査 |
| Phase 1の11 workspace | すべてtypecheck、test、build PASS |

Phase 1 testにskip、todo、失敗はない。

## skipなし正規検証

- 終了確認: 2026-08-31T17:59:40+09:00
- command: `env -u FEEDBACK_VERIFY_SKIP_NPM_CI -u FEEDBACK_VERIFY_SKIP_COMMON_CONTRACTS bash scripts/verify-feedback.sh`
- skip環境変数: `FEEDBACK_VERIFY_SKIP_NPM_CI`、`FEEDBACK_VERIFY_SKIP_COMMON_CONTRACTS`ともに未設定
- 結果: `[feedback-phase0] PASS`、`[feedback-phase1] PASS`、`[feedback-redmine-verify] PASS`、`[feedback-verify] PASS`

clean `npm ci`、契約drift／Spectral、Phase 0／1 gate、全workspace typecheck／test／build、React 18／19 consumer、Chrome smoke、container security、Redmine 5.1.12／6.0.10／6.1.3／7.0.0の実REST conformance、release／publish／multi-architecture container gateが成功した。今回変更による失敗と既存失敗はいずれもない。

既存の`@geibee/redmine-demo` test scriptは`--passWithNoTests`でtest file 0件のまま終了しており、Phase 1のtest成功件数には含めていない。demo buildと別packageのChrome smokeは成功した。npm dependencyのdeprecated警告とRedmine 6.1のRuby `ostruct`警告は出力されたが、検査失敗はなかった。

## Phase 2開始前の停止条件

Phase 2へは進まない。管理されたJira Cloud test tenantへissue／comment／attachmentを作成する前に、対象tenant、利用credential、削除方針を含む明示的なwrite許可を別promptで得る。許可前にcreate／reply／revisionの保証水準やproperty検索のread-after-write性をlive確認済みとして扱わない。
