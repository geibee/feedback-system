# Feedback Service v2 deployment

## 配備単位

配備物は次の二つで、同じprocessやmanifestへ統合しない。

1. `apps/feedback-service-runtime`: Feedback Service、request-scoped Jira／Redmine／Backlog Connector adapter registry、Envelope verifier、Node.js listenerを含むDBレスruntime。
2. `packages/feedback-connector-jira-cloud/forge-app`: Jira issue entity propertyをJQL index化するForge development／production artifact。function、UI、Forge Storage、Connect moduleを持たない。

runtimeはDB、queue、persistent／shared application data cache、upload directory、private object storage、ホストDBを必要としない。ticket本文、会話、証跡、回復metadataはproviderを正本とする。container filesystemへ設定以外を書かず、設定はread-only mount、secretはorchestratorから環境変数へ注入する。最終imageはproduction `dist`とpackage manifestだけを含み、Forge artifact、source、test、dev dependencyを同梱しない。

## 配備順序

2026-09-06修正ではBacklogのproject／custom field／issue type／priority疎通検査をmanaged provisioning検査に限定する。`/readyz`は全providerでローカルの設定・secret形式検証だけを行う。瞬間的なprovider障害を他profileのreadinessへ伝播させない。新しいEnvelope fieldを読むcodec／contracts／Connectorは同時に配備し、旧DB保存版の移行処理を追加しない。

1. 対象Jira environmentへForge entity property artifactを`forge lint`後にdeployし、Jira siteへinstallまたはmajor-version upgradeする。
2. entity property indexの`threadId`、`intentId`、`requestHash`完全一致検索をmanaged acceptanceで確認する。
3. Redmine対象ではv2 custom field provisioning planをread-onlyで確認し、承認済みの別作業でapplyする。既存v1 fieldは変更しない。
4. Backlog対象では同一projectへ任意Text custom field `feedback.threadId`、`feedback.intentId`、`feedback.requestHash`、`feedback.resourceKey`を作成し、ID、issue type、priorityをcatalogへ固定する。attachment operationはprofileへ設定しない。
5. provider profile、Connector runtime catalog、secret referenceを配備する。
6. `apps/feedback-service-runtime/Dockerfile`をbuildし、immutable digestで配備する。
7. `/healthz`、`/readyz`、profile read、provider acceptanceを確認してtrafficを切り替える。

Forge deploy／install credentialはFeedback Serviceへ渡さない。Jira REST credentialはprovider profileの`providerCredential` secretだけから解決する。

## 起動検査

- provider profileの`connectorProfileRef`がcatalogに一件だけ存在し、`connectorKey`が一致する。
- Redmine workspace bindingはprofile allowlistの単一workspaceと一致する。
- Backlog workspace bindingはprofile allowlistの単一workspaceと一致し、project、4 Text custom field、issue type、priorityのprovider readinessが成功する。
- Authorization Modeごとのportが存在し、別modeへfallbackしない。
- `remote-authorization`はhostの認証済みsubject adapterがない限りlistenしない。
- Envelope／participant credential key ringはactive一鍵、最大8鍵、全鍵32 bytes以上のcanonical base64urlとしてparseでき、participant ID derivation鍵とsecret IDを分離する。
- provider credentialはJira Cloudの`jira-cloud-basic`、Redmineの`redmine-api-key`、Backlogの`backlog-api-key` exact JSONとしてregistryでparseでき、署名鍵とprofile secret referenceをすべて解決できる。不正形式では`/readyz`を503にする。

Jira Cloud／Redmine readinessは設定とsecret解決を検査する。Backlogはprovider側provisioning driftをfail-closedにするためAPI readも行う。orchestratorのrestart判定には`/healthz`を使い、Backlog瞬断だけでprocessを再起動しない。provider障害中のoffline readは提供しない。

## release前live Gate

保存済みevidenceのboolean確認だけではlive Gate通過としない。release候補sourceで`bash scripts/check-feedback-phase5-live.sh`を明示実行し、run-owned issueの作成、回収、comment、revision、attachment、再読込、cleanupを同じrunで完了させる。credentialは`FEEDBACK_JIRA_ACCEPTANCE_CREDENTIAL_FIFO`または一時的なprocess環境からだけ渡し、fixtureへ保存しない。出力の`implementationDigest`はOpenAPI、attachment schema、Jira Connector、REST client、live runnerへ束縛し、`scripts/check-feedback-phase5.sh`で現sourceと再比較する。

Backlog Stage A live Gateは`tests/fixtures/backlog-stage-a/live-gate.json`、4つ目の`feedback.resourceKey`を含むStage B live Conformanceは`tests/fixtures/backlog-stage-b/live-conformance.json`へ匿名化して保存する。release候補では`bash scripts/check-feedback-backlog-live.sh`を実行し、現Backlog Connectorのsource digest、回復、再構築、cleanupを更新する。Stage Aで確認した一時attachment IDと最終IDの不一致を理由にattachmentを有効化してはならない。

release用runtimeは`bash scripts/build-feedback-service-release.sh`で`linux/amd64`／`linux/arm64` OCI、SBOM、脆弱性report、checksum、provider live evidence bindingを一組として生成する。`feedback-service-release-manifest.json`の`indexDigest`を配備時に固定し、tagだけを配備参照にしない。
