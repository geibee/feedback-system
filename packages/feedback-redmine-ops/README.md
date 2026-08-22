# `@geibee/feedback-redmine-ops`

Feedback Redmineのローカル評価、既存Redmineの読取診断、gateway疎通確認、バックアップ・復元を行うCLIです。

```bash
npx @geibee/feedback-redmine-ops@<version> local up
npx @geibee/feedback-redmine-ops@<version> local credentials
npx @geibee/feedback-redmine-ops@<version> doctor --origin https://app.example --profile inventory-production
```

Rails runnerを利用できないmanaged Redmineでは、管理者が次の二段階inspectを行います。

```bash
export FEEDBACK_REDMINE_INSPECT_API_KEY='<temporary-admin-key>'
npx @geibee/feedback-redmine-ops@<version> inspect \
  --manifest feedback-redmine-installation.json \
  --manual-checklist feedback-redmine-manual-checklist.md \
  --output feedback-redmine-inspection.json
unset FEEDBACK_REDMINE_INSPECT_API_KEY

# checklistの15項目をRedmine管理画面で確認してから、inspectionに出力された同じdigestを指定する
export FEEDBACK_REDMINE_INSPECT_API_KEY='<temporary-admin-key>'
npx @geibee/feedback-redmine-ops@<version> inspect \
  --manifest feedback-redmine-installation.json \
  --accept-manual-checks <manualCheckDigest> \
  --generated-dir feedback-redmine-generated \
  --output feedback-redmine-inspection-accepted.json
unset FEEDBACK_REDMINE_INSPECT_API_KEY
```

初回は未承認のため終了code 2、承認対象と異なるdigestは1、REST検査成功かつ同じdigestの承認後は0です。API keyを引数、manifest、
inspection、checklist、profileへ保存しません。Redmineまたはmanifestの設定を変更した場合は、最初のinspectからやり直して新しいdigestを確認します。

Redmineを変更するRails runnerは既定でplanだけを出力し、同じplan digestを明示したapplyだけを許可します。詳しい手順は
`docs/feedback-redmine-installation.md`を参照してください。

ローカルdemoの管理者案内は`.feedback-redmine/public/feedback-redmine.json`を編集してブラウザを再読み込みすると反映されます。
公開用directoryだけをread-only mountするため、同じstate directory内のsecretはdemo containerへ渡しません。

`local backup`はRedmineを停止してDB、files、復元に必要なローカルsecret/profileを同じ世代で保存します。`local restore`と
`local reset`は`--yes`を必須とする破壊的操作です。顧客Redmineではローカル用`--local-evaluation`を使用しません。
