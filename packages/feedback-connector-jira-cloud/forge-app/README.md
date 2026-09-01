# Jira Cloud projection index

Jira Connectorに付随する独立deploy artifactです。issue property
`com.geibee.feedback.recovery.v2`の`threadId`、`intentId`、`requestHash`だけを
JQL候補検索用にindex化します。

- Feedback Serviceへ組み込まない。
- function、UI、Forge Storage、Connect moduleを追加しない。
- JQL結果は未信頼候補として扱い、Connectorがpropertyを直接再読込する。
- GatewayがEnvelope署名、provider binding、scope、現在の認可を検証するまで返却しない。

deploy／install／upgradeはConnector releaseとは別の運用手順で行います。manifestの
`app.id`はPhase 2で管理されたdevelopment siteへinstall済みの公開app識別子です。
