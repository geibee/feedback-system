# Jira Cloud Phase 0 fixture

このdirectoryのJSONは、2026-08-31時点のJira Cloud公式資料から作成した契約検討用の合成fixtureです。live tenantのrequest／responseではありません。

- Jira Cloudだけを対象とし、Data Centerの挙動を表しません。
- tenant URL、credential、実在account IDを含みません。
- `request`はREST API v3へ送る候補、`providerResult`は反例を作るための最小形です。Jira REST response全体のgolden fixtureではありません。
- `expectedConnectorDecision`はPhase 0の安全側の期待値です。
- `requiresLiveConfirmation`が空でない項目は、管理されたtest tenantで確認するまでprovider保証として公開しません。
- 検索候補はprojectionだけで採用せず、署名済みEnvelope、provider binding、scope、現在の認可を検証します。

根拠は`docs/phase0/jira-cloud-constraints.md`を参照してください。
