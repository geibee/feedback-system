# Jira Cloud Phase 2 index module

Phase 2 contract spikeで、issue property `com.geibee.feedback.recovery.v2` の
`threadId`、`intentId`、`requestHash`を完全一致JQLの候補抽出対象にする最小Forge manifestである。

- function、UI、Forge storage、Connect moduleは持たない。
- property indexは候補抽出専用であり、検索結果を認可済みFeedbackとして信頼しない。
- Connectorは候補の正本propertyを読み、署名Envelope、provider binding、scope、現在の認可を検証する。
- `app.id`は公開可能なForge app識別子であり、credentialではない。
- Phase 2完了後もdevelopment installationは保持する。test issueだけをrun IDで限定して削除する。
