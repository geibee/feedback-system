# `@geibee/redmine-ops`

Feedback Redmineのローカル評価、既存Redmineの読取診断、gateway疎通確認、バックアップ・復元を行うCLIです。

```bash
npx @geibee/redmine-ops@1.0.0 local up
npx @geibee/redmine-ops@1.0.0 local credentials
FEEDBACK_REDMINE_INSPECT_API_KEY='<temporary-admin-key>' \
  npx @geibee/redmine-ops@1.0.0 inspect --manifest feedback-redmine-installation.json
npx @geibee/redmine-ops@1.0.0 doctor --origin https://app.example --profile inventory-production
```

Redmineを変更するRails runnerは既定でplanだけを出力し、同じplan digestを明示したapplyだけを許可します。詳しい手順は
`docs/feedback-redmine-installation.md`を参照してください。

`local backup`はRedmineを停止してDB、files、復元に必要なローカルsecret/profileを同じ世代で保存します。`local restore`と
`local reset`は`--yes`を必須とする破壊的操作です。顧客Redmineではローカル用`--local-evaluation`を使用しません。
