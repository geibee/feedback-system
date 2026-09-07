# @geibee/feedback-connector-jira-cloud

Jira Cloud REST API v3だけを対象とするDBレスConnectorです。issue、comment、entity
property、attachmentをprovider正本として扱い、JQL indexは候補抽出にだけ利用します。

`createFeedbackJiraCloudConnector`はrequest participantごとに生成します。provider credentialを
保持するfetch transport、server-side Envelope codec、read-only configurationを注入し、DB、queue、
共有cache、upload directory、private object storageは使用しません。

主な安全境界:

- issue作成の最初のPOSTで`threadId`、`intentId`、`requestHash`を同時保存する。
- JQL hit後にissue propertyを直接再読込し、raw candidateをGatewayへ返す。
- reply／revisionは本文と署名markerを単一comment POSTに保存する。
- attachment binaryはstreamで一回だけ送信し、timeout／5xx／429時も自動再送しない。
- 署名済みstable attachment mappingはupload成功response後にだけ保存する。
- 403、404、409、413、415、429、5xx、timeoutをfrozen Problem codeへ正規化する。
- JSON responseは2 MiBで打ち切り、attachment downloadは署名済みsizeとの完全一致を検査する。
- REST writeのredirectは拒否し、attachment GETのcross-origin redirectではcredentialを除去する。
- Jira component discoveryはsigned grant互換の`record` resourceへ正規化する。
- comment本文は署名済み`bodyHash`と照合し、revision chainの分岐・gap・循環を拒否する。
- detailのmessage本文は検証済みchainの最新revisionを反映する。
- attachmentは署名済み`messageId`へ関連付け、download完了時にsizeとSHA-256を検査する。
- attachment upload前に検証済みthread上のmessage存在を確認し、orphan binary writeを防ぐ。

[`forge-app/manifest.yml`](./forge-app/manifest.yml)はConnectorに付随する独立deploy artifactです。
entity property indexだけを宣言し、Feedback Service依存、function、UI、Storage、Connect moduleを
持ちません。Jira Data Centerは対象外です。
