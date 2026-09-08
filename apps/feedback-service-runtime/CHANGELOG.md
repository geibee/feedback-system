# 変更履歴

## 1.0.0-rc.3 - 2026-09-09

- RC.2で判明したOCI imageのbuild時刻依存を除去し、同一commitの再buildで同じdigestを生成する。公開APIと実行時挙動は変更しない。

## 1.0.0-rc.2 - 2026-09-08

- RC.1 release集合のstale build混入を解消するclean rebuild。runtime構成とprovider capabilityは変更しない。

## 未リリース - 2026-09-07

- 共通参照契約alpha.3へ対応したService・Connectorを同梱する。live証跡は公開clientからService・projection・Connectorまでのsourceへ束縛する。

## 未リリース - 2026-09-06

- Backlogの一時的な疎通障害をreadinessへ伝播させず、設定・secret形式検証と配備前provisioning検査を分離した。

## 1.0.0-rc.1 - 2026-09-02

- `/readyz`でsecret形式検証失敗をHTTP 503として返すようにした。
- provider adapter registryへJira Cloud／Redmineを移し、Backlog Connectorを同じ登録点へ追加した。
- Backlog provisioning readinessとattachment unsupported capabilityを追加した。
- release OCIの最終stageをnonroot distroless Node 22へ固定し、shell／package managerを同梱しないようにした。

## 1.0.0-alpha.7

- Jira Cloud／Redmine Connector、production Envelope verifier、request participant、Node.js listenerをDBレスcompositionへ接続した。
