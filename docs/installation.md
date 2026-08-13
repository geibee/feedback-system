# 宣言的インストール

Feedback Service v1は、1つの組織またはtrust domainごとにServiceを配備する。`tenantKey`は認証・監査・rate limitの
境界だが、公開APIのnamespaceではない。したがって`applicationKey`は1つのService全体で一意であり、異なるtenantで
同じ`portal`などのkeyを共有できない。複数組織で同じkeyを使う場合はServiceを分ける。

この制約を変更して共有マルチテナントにする場合は、`tenantKey`をHostContextと全API scopeへ追加し、DB制約を
`UNIQUE (tenant_id, application_key)`へ変更する。その変更は`/feedback/v2`と`@feedback/*` 2.xで行う。

## Installation manifest

CI/CDでは[`deploy/feedback-installation.example.json`](../deploy/feedback-installation.example.json)を複製し、
`feedback-bootstrap --input`へ渡す。schemaの正本は
`contracts/feedback/schemas/installation-manifest.schema.json`である。

```bash
feedback-bootstrap --input /run/config/feedback-installation.json
```

`entries`はworkspace membership単位である。同じtenant、application、environment、workspaceを複数entryへ記述してよい。
全entryを検証してから1つのDB transactionで冪等upsertするため、途中失敗で一部だけ反映されない。manifestにないresourceや
membershipは削除しない。削除は意図しない権限喪失を防ぐためAdmin APIで明示的に行う。
同じapplication内の同一主体はapplication membershipも共有するため、複数workspaceへ記述する場合も同じ`permissions`を
指定する。不一致はentry順による権限変化を避けるため反映前に拒否する。

初回アクセス前の主体も`issuer`と`subject`で作成できるので、「一度アクセスして拒否された後でmembershipを追加する」手順は
不要である。secretはmanifestへ記述せず、DB credentialは従来どおり環境変数またはsecret mountで渡す。

application manifestは別の公開契約であり、resource同期後に`feedback manifest apply`で同期する。推奨するCI/CD順序は次のとおり。

1. `feedback-migrate`
2. `feedback-bootstrap --input /run/config/feedback-installation.json`
3. APIをrolling deploymentし、readinessの成功を確認
4. `feedback manifest apply --input /run/config/application-manifest.json --api-base-url https://feedback.example.com/feedback/v1`
5. consumerと必要なworkerをdeploy
