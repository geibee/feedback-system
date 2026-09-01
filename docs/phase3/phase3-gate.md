# Phase 3 Gate

確認日: 2026-09-01

契約freeze: `feedback-v2-contract-2.0.0-alpha.1`

## 判定

Phase 3 GateはPASSとする。Phase 4のrenderer実装は開始していない。

Phase 3では`contracts/feedback`のOpenAPI、JSON Schema、生成型、fixtureを変更していない。Phase 2でfreezeしたquery、command、result、Problem、intent回収、attachment、authorization、Envelope、controller契約を各laneが実装した。

## Lane A: Feedback Service／gateway

- DB、queue、persistent／shared application data cache、upload directory、private object storage、ホストDBへの依存を追加していない。
- read-only settings／provider profileとserver-side secret resolverを実装した。secretに既定値はない。
- `public-profile`、`signed-grant`、`remote-authorization`をprofileごとに固定し、別modeへのfallbackを禁止した。
- signed grantはissuer、audience、target、scope、operation、`jti`、300秒寿命、330秒失効上限、JWKS key bindingを検証する。
- remote authorizationは認証済みsubject、2000 ms timeout、exact responseを検証し、失敗時はfail-closedにする。
- 認可結果、profile policy、backend capabilityの積集合だけを有効権限にする。
- projectionは候補抽出専用とし、provider直接再読込、Envelope署名、provider binding、scope検証後だけ返す。
- Web標準HTTP adapterでsame-origin、CSRF、content type、stream request size、hard deadline、strict query／DTO、IDOR境界を検証する。
- `feedback:attachment:upload`を独立権限として検証し、binary bodyは一度だけ消費する。
- v1 facadeは同じprofileの同じAuthorization Modeを通し、mode fallbackを許さない。

## Lane B: Redmine Connector

- issue作成の最初のwriteへ`threadId`、`intentId`、`requestHash`を同時保存し、その後にEnvelopeとprojectionを段階保存する。
- legacy ticketをstable IDで再構築し、v1 markerと署名済みv2 markerをdual-writeする。
- create／replyはprovider検索から回収し、revision／attachment結果不明時は自動再writeしない。
- attachment downloadはprovider metadataを直接再読込し、profile上限、署名済みmapping、hashを検証する。
- 既存v1の11 custom fieldを変更しないv2専用Rails runnerを独立運用artifactとして追加した。planはread-only、applyは競合なしの同一digestだけを許可する。
- v1 readerの公開shapeを変えず、dual-writeが使用するUUIDv7／UUIDv8を欠落させない互換受理を追加した。

## Lane C: Jira Cloud Connector

- Jira Cloud REST API v3だけを対象とし、issue、comment、entity property、attachmentをprovider正本として実装した。
- JQLは候補抽出だけに使用し、propertyを直接再読込する。0件、複数件、不正projection、pagination循環をfail-closedにする。
- createの最初のPOSTへ回復tripletを保存し、reply／revision markerとattachment mappingをprovider propertyへ保存する。
- writeを自動retryせず、write redirectを拒否する。attachment downloadのcross-origin redirectではAuthorizationを除去する。
- JSON responseは2 MiB、page／cursor／JQL入力、attachment sizeを有界にした。

Forge entity property indexは[`packages/feedback-connector-jira-cloud/forge-app/manifest.yml`](../../packages/feedback-connector-jira-cloud/forge-app/manifest.yml)にあるJira Connector付随の独立deploy artifactである。Phase 2の管理済みdevelopment siteで確認したmanifestと同一で、`jira:entityProperty`だけを持つ。function、UI、Forge Storage、Connect moduleは持たず、Feedback Serviceのmanifest、dependency、runtime bindingへ組み込まない。

Phase 3では外部Jira siteへのwrite、deploy、install、upgradeを実行していない。管理tenantでの実測根拠はPhase 2のsanitized fixtureを再利用した。

## Lane D: browser headless stack

- same-origin generic HTTP client、strict credential選択、Problem写像、multipart一回送信、stream downloadを実装した。
- `ClientStateV2`、安全に写像できるv1 draft／followだけのlegacy reader、端末内pending intentを実装した。
- frozen golden snapshotに対するheadless controllerを実装した。
- clock、scheduler、visibility、storage、ID生成、navigation、captureを注入可能にした。
- follow、unread、pending回収、capture cancellation、navigation、destroy後callback禁止をtestした。

端末間draft／follow／unread同期、provider障害中のoffline read、exactly-once、不変監査は追加していない。

## Gate証跡

`scripts/check-feedback-phase3.sh`は次をfail-closedで検査する。

- Phase 3成果物と全lane checklist
- Forge artifactの独立性、Phase 2 live manifestとのbyte一致、index field
- Feedback Serviceへの永続化／Forge／provider Connector依存の不在
- v1 dual-write UUID互換
- Lane A〜Dとv1 core integrationのscoped typecheck／test

最終の正規入口はskip変数を設定せずに`bash scripts/verify-feedback.sh`を実行する。実行結果はこの変更の完了報告へ記録する。

## 後続Phaseへ持ち越す接続作業

次はfrozen契約の判断残しではなく、計画済みの後続実装である。

- Phase 4: React rendererとWeb Componentをheadless controllerへ接続する。
- Phase 5: deployごとのrequest participantに束縛したConnector factory、production Envelope verifier、profile選択、network listenerをFeedback Service compositionへ接続する。
- Phase 5のJira acceptanceで外部writeを再実行する前に、development siteへのissue／comment／attachment作成許可とcleanup対象をその実行単位で確認する。
