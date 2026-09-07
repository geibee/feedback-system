# 共通thread参照契約の導入（2026-09-07）

## 結論

> リリース検証追記: 2026-09-07にJira／Backlogのalpha.3 live Gateを再実行し、run-owned dataの全cleanupと、skipなしの正規`bash scripts/verify-feedback.sh`のPASSを確認した。以下の「未実行」「FAIL」は実装直後の時点記録であり、最終状態は[リリース準備記録](release-preparation-2026-09-07.md)を正とする。

DBレス／重複排除best-effortを維持し、共通契約alpha.3と、Service・3 Connector・HTTP client・controllerへの参照伝播を実装した。React／Web Componentは共通controller経由で利用する。旧v2応答とRedmine v1は維持する。

本番有効化とJira／Backlog live再検証は実施していない。リリース承認ではない。正規検証はPhase 5の旧live証跡で停止し、全体FAIL（exit 1）。Phase 0〜4と現行Redmine検証はPASSした。

## 固定した判断

- 正本: [Thread Reference v1](../contracts/feedback/thread-reference.md)、[ADR 0005](adr/0005-protected-thread-reference.md)。
- tokenは認証付き暗号化された参照先であり、認可根拠ではない。scope／audience／provider bindingと現在の認可を検証する。
- 参照取得後の個別操作は検索fallbackなし。初回応答喪失・一覧探索は検索依存が残り、重複排除はbest-effort。
- optional opt-inで旧clientのstrict DTOを維持する。tokenはcommand hashとURLへ混ぜない。
- 独立secretの鍵ring、30日寿命、失効時のfail-closed、scope別の端末保存、pending intentへの保持を固定した。
- 同時refreshで固定参照を別候補へ上書きせず、遅いfollow pollで新しい参照を巻き戻さない。
- Thread schemaのallOf／additionalPropertiesの矛盾も、既存JSON形状を変更せず訂正した。

## 主な変更file

| 領域 | file |
| --- | --- |
| 正本・生成型 | contracts/feedback/feedback-gateway.openapi.yaml、schemas/feedback-provider-profile.schema.json、src/feedback-gateway.generated.ts、src/feedback-provider-profile.generated.ts、src/v2.ts、thread-reference.md |
| 共通server port | packages/feedback-connector-sdk/src/index.ts、src/testing.ts、packages/feedback-gateway/src/application.ts |
| Service | apps/feedback-service/src/thread-reference.ts、configuration.ts、http.ts、service.ts |
| Connector | packages/feedback-connector-redmine/src/connector.ts、packages/feedback-connector-jira-cloud/src/connector.ts、packages/feedback-connector-backlog/src/connector.ts |
| client・controller | packages/feedback-client/src/index.ts、http.ts、packages/feedback-controller/src/index.ts、controller.ts、state.ts |
| 契約・Service test | contracts/feedback/src/v2-openapi-contract.test.ts、apps/feedback-service/src/thread-reference.test.ts、http.test.ts、service.test.ts、configuration.test.ts |
| Connector test | Redmineのsrc/production.test.ts、Jira／Backlogのsrc/connector.test.ts |
| consumer test | packages/feedback-client/src/contract.test.ts、packages/feedback-controller/src/implementation.test.ts、tests/feedback-provider-acceptance/src/renderers.test.tsx、service-client-jira.test.ts、backlog-stage-b-live.test.ts |
| version照合 | scripts/check-feedback-phase5.sh、check-feedback-phase5-live.sh、check-feedback-backlog-live.sh、check-feedback-service-release.sh、run-feedback-jira-live-acceptance.mjs、run-feedback-backlog-stage-a.mjs、run-feedback-backlog-live-conformance.mjs |
| 文書・互換性 | contracts/feedback/README.md、CHANGELOG.md、docs/adr/0004-contract-ownership-and-v1-v2-boundary.md、0005-protected-thread-reference.md、docs/api-compatibility.md、environment-variables.md、phase2/contract-freeze.md、phase5/contract-freeze.sha256、phase5/phase5-gate.md、feedback-system-generalization-design.md、feedback-system-generalization-plan.md、本書 |

root package.json／lockfileとRedmine v1 OpenAPI／生成型は変更していない。stage／commit／push／deploymentは実施していない。既存のlive再検証文書・fixture差分・Backlog診断の追加は保持し、保存済みlive JSONを書き換えて今回の成功に見せていない。

## 検証

変更したpackageでtypecheck／test／buildを実行。下記件数は各package単独での件数であり、Gate内の重複実行を合算しない。

| 対象 | 結果 |
| --- | --- |
| 共通契約・生成drift・Spectral | PASS、contract test 32件 |
| HTTP client | PASS、18件 |
| controller | PASS、17件（保存・remount・pending回収・poll競合を含む） |
| Service | PASS、49件（AEAD・失効・scope／audience・認可取消し・readiness等） |
| Redmine Connector | PASS、27件 |
| Jira Connector | PASS、40件 |
| Backlog Connector | PASS、6件（同じthreadIdの2件を持つfixtureと検索禁止下の直接操作を含む） |
| React／Web Component | PASS、各9件 |
| Service→client→controller／両renderer scoped acceptance | PASS、10件 |
| production runtime | typecheck PASS、test 15件PASS。初回はsandboxのlocalhost listen制限で2件失敗し、権限付き再実行で全件PASS |
| provider acceptance全体 | FAIL、14件中12件PASS／2件FAIL。Backlog Stage Aの旧digestとStage Bの旧契約版が現sourceに一致しない |
| git diff --check | PASS |

正規検証:

- 初回 `bash scripts/verify-feedback.sh`: skip指定なし、exit 126。Phase 0〜3通過後、Phase 4のDocker socketアクセスがsandboxで拒否された。[初回log](/tmp/feedback-thread-reference-verify.uGEFR4/verify-feedback.log)。
- 権限付き再実行: skip指定なしで先頭から実行し、exit 1。Phase 0〜4、Redmineのpackage／contract／browser・plugin smoke／security／4対応版conformance（5.1.12、6.0.10、6.1.3、7.0.0）／release／publish／container platformはPASS。Phase 5は旧alpha.2のJira live証跡をalpha.3として受理できずFAIL。その後のFeedback Service publish／release検査は未到達。[再実行log](/tmp/feedback-thread-reference-verify.uGEFR4/verify-feedback-full.log)。

正規検証の停止後にも、provider acceptanceのtypecheckと参照経路scoped 10件、production runtimeのtypecheck／15件を再確認した。runtime初回の環境制限失敗は上表のとおりであり、無条件の初回成功とは扱わない。

今回のsource変更前にも、前回の正規検証はBacklog Stage B live digest不一致で失敗していた（[前回log](/tmp/feedback-backlog-diagnostic.BAvmyk/verify-feedback.log)、[前回報告](live-revalidation-2026-09-07.md)）。今回はalpha.3への契約変更とConnector変更によって、Jira／Backlogの旧live証跡も再利用できない。これは今回のliveが成功した、または失敗したという意味ではなく、今回のliveを実行していないため承認できないという意味である。

## 有効化前に必要な作業

1. [環境変数文書](environment-variables.md)に従い、対象profileへ独立したthreadReferenceKeyRingを配備する。未設定profileでは新tokenを発行しない。secretに既定値はない。
2. Serviceを先に更新し、その後clientを更新する。参照付きclientと旧Serviceの組合せはサポートしない。
3. 管理test tenantで参照経路を含むJira／Backlog live再検証を行い、成功した実行だけを現契約・sourceへ束縛した証跡として保存する。今回tenantへのwriteやcredential取得は行っていない。
4. 正規検証を再実行する。旧live証跡のversionやdigestだけを手修正してGateを通さない。
