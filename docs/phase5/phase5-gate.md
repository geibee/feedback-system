# Phase 5 Gate

確認日: 2026-09-01

契約freeze: `feedback-v2-contract-2.0.0-alpha.3`

> 2026-09-07追記: 暗号化threadReferenceを含むalpha.3のJira／Backlog live Gateと正規verifyを再実行し、現sourceへ束縛した。詳細は[リリース準備記録](../release-preparation-2026-09-07.md)を参照する。

## 判定

**PASS**。release前監査の修正とalpha.3の暗号化threadReferenceを実装し、production composition、actual client／Service／Connector acceptance、browser write、10行compatibility matrix、fault injection、運用文書、Forge deploy／installation、現sourceへ束縛したJira Cloud／Backlog live acceptance、正規`bash scripts/verify-feedback.sh`がすべて成功した。Feedback Serviceへの専用DB等の追加はない。

## 判定対象

Phase 5のproduction composition、provider共通acceptance、compatibility matrix、fault injection、運用文書、管理Jira Cloud開発siteとBacklog test projectの実証をGate対象とする。Phase 2／4のalpha.1 checksumは履歴証跡として保持し、release訂正後のOpenAPI、thread reference正本、schema、server／browser port、TCK fixtureは`docs/phase5/contract-freeze.sha256`のalpha.3 checksumで固定する。

## production topology

- `apps/feedback-service-runtime`がFeedback Serviceとrequest-scoped Jira／Redmine Connectorを認可後に統合する。Feedback Service coreはprovider実装に依存しない。
- runtimeはDB、queue、persistent／shared application data cache、upload directory、private object storage、ホストDBを使わない。provider ticketと署名metadataを正本とする。
- Forge `jira:entityProperty` indexはJira Connectorに付随する独立deploy artifactとし、Feedback Service runtime imageへ含めない。Forge Storage、function、UI、Connect moduleを持たない。
- projectionは候補抽出だけに使い、provider正本の再読込、Envelope署名、provider binding、scope、現在の認可、profile policy、backend capabilityを再検証する。

## compatibility／fault

- v1／v2の10行は`docs/phase5/compatibility-matrix.md`でRedmine 4 version conformance、v1 characterization、Jira live acceptance、production verifier fixtureへ対応付けた。
- partial write、timeout、unknown `kid`、旧verify-only鍵、projection改ざん、rollback、attachment mapping障害はfault fixtureでfail-closedを確認する。
- create／replyはprovider上の一意回収だけを行い、revision／attachmentの結果不明時は自動再write／再uploadせずmanual confirmationへ閉じる。
- ReactとWeb Componentは`@geibee/feedback-provider-acceptance`の同一suiteをJira Cloud／Redmineに対して実行し、submit、pendingからの回収、reply、revision、File-backed attachment uploadを通す。
- 別のactual integration acceptanceでproduction HTTP client、Feedback Service、Gateway、projection verifier、Jira Connectorを接続し、public participant発行、credential付きcreate、結果不明回収、署名済み本文readを通す。in-memoryなのはHTTP／Jira transport境界だけである。

## 管理環境証跡

- Forge CLI 13.5.0でdevelopment environmentへentity property index artifactをdeployした。既存installationは`Up-to-date`と再確認した。同一permissions／code versionへのcode-only upgrade要求はForgeが拒否したため、installationの変更は行っていない。
- 2026-09-01T05:37:24.716ZにJira Cloud REST API v3でrun-owned issueを1件作成し、first-write tripletの一意回収、comment、append-only revision、署名本文binding、最新本文、返信へのattachment関連付け、upload／download hashを確認した。
- acceptanceが作成したrun-owned issueは終了時に削除した。既存issue、project、Forge installationはcleanup対象にしていない。
- 証跡fixtureはsite URL、project／issue／account／installation ID、email、credentialを保存しない。

## 運用境界

deployment、保存形式migration、key rotation、incident、rollbackは`docs/phase5`配下で固定した。provider profile schema、Connector catalog実装、例、環境変数文書のfail-closed drift検査を`scripts/check-feedback-phase5.sh`に含める。readinessはkey ring、導出鍵、Jira／Redmine credentialをexact parseし、不正時はHTTP 503とする。secretに既定値はない。

保存済みlive JSONだけではGate通過としない。`scripts/check-feedback-phase5-live.sh`をrelease候補sourceで明示実行し、run-owned issueのcleanupまで同じrunで確認する。保存するsanitized JSONはOpenAPI、attachment schema、Jira Connector、REST client、runnerの`implementationDigest`へ束縛し、正規verifyで現sourceと再比較する。

## 検証記録

2026-09-01に次を実行した。

- `bash scripts/check-feedback-phase5-live.sh`: PASS。run-owned issueだけを書き込み、本文／revision／attachment bindingを確認後に削除した。自動write retryは0回である。
- `bash scripts/check-feedback-phase5.sh`: PASS。alpha.2 contract checksum、live implementation digest、共通契約／設定drift、Dockerfile、Gateway 12件、Feedback Service 41件、Redmine Connector 23件、Jira Connector 38件、Controller 13件、React／Web Component各9件、production runtime 13件、provider acceptance 9件が成功した。
- `bash scripts/verify-feedback.sh`: skip環境変数を指定せず直列実行してPASS。clean `npm ci`、Phase 0〜5、React 18／19 clean consumer、実Chrome smoke、Redmine 5.1.12／6.0.10／6.1.3／7.0.0 container conformance、security、release／publish／container platform検査が成功した。
- `apps/feedback-redmine-demo`は既存の`--passWithNoTests`によりtest fileなしで終了する。これをtest成功件数には含めず、buildと実Chrome smokeで検証した。
- Jira Cloud live acceptanceは`tests/fixtures/jira-cloud-phase5/live-acceptance.json`の通りPASS。作成したrun-owned issueは削除済みで、自動write retryは0回である。

2026-09-07にalpha.3候補で次を再実行した。

- Jira Cloud live: PASS。公開credentialからService／client／Connectorを通る直接参照、Service再構成、reply／revision／intent回収、添付、改ざん・scope不一致・認可取消しを確認した。最終runは作成二件・削除二件・失敗0。先行runの未追跡二件も一件ずつ厳密照合して削除した。
- Backlog Stage A／B live: PASS。重複検索一件を全体一意性とは扱わず、固定参照で別issueへの操作混入を防いだ。最終Stage Bはcleanup対象四件・失敗0・残存0。
- provider acceptance: 21件PASS。
- `bash scripts/check-feedback-phase5.sh`: PASS。
- `bash scripts/verify-feedback.sh`: skipなし、終了コード0、`[feedback-verify] PASS`。

Phase 5 Gate通過後は後続Phaseへ進まず停止する。
