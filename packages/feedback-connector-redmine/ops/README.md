# Redmine v2 custom field provisioner

既存v1 provisionerが管理する11 fieldを変更せず、Feedback v2 Connectorで追加するIntent ID、Envelope、Projectionの3 fieldだけを作成するRails runnerです。既存6 fieldと新規3 fieldの合計9 fieldについて、名前、型、検索可否、project／tracker／role割当を検証します。

入力例:

```json
{
  "schemaVersion": "2",
  "profileId": "feedback-redmine",
  "projectId": 10,
  "trackerId": 20,
  "roleId": 30
}
```

最初にplanを実行します。

```sh
bundle exec rails runner /path/to/feedback_redmine_v2_custom_fields.rb plan config.json output
```

出力された`feedback-v2-custom-fields-plan.json`の競合と`planDigest`を確認後、同じconfigとdigestでapplyします。

```sh
bundle exec rails runner /path/to/feedback_redmine_v2_custom_fields.rb apply config.json output PLAN_DIGEST
```

planはproviderを変更しません。applyもdigest一致前にはprovider writeを行わず、既存fieldを更新・削除しません。途中失敗はtransactionでrollbackし、再度planから実行します。出力ファイルはcredentialを含みませんが、権限情報としてmode `0600`で保存します。
