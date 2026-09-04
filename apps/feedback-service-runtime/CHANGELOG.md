# 変更履歴

## 1.0.0-rc.1 - 2026-09-02

- `/readyz`でsecret形式検証失敗をHTTP 503として返すようにした。
- provider adapter registryへJira Cloud／Redmineを移し、Backlog Connectorを同じ登録点へ追加した。
- Backlog provisioning readinessとattachment unsupported capabilityを追加した。
- release OCIの最終stageをnonroot distroless Node 22へ固定し、shell／package managerを同梱しないようにした。

## 1.0.0-alpha.7

- Jira Cloud／Redmine Connector、production Envelope verifier、request participant、Node.js listenerをDBレスcompositionへ接続した。
