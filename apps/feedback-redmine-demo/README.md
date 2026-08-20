# Feedback Redmine local demo

`@feedback/redmine-plugin`の配備時runtime config、位置指定、右クリック、screenshot、Workspace一覧、thread詳細を確認する
ローカル評価用SPAです。本番業務SPAの代替ではありません。

repository rootで次を実行すると、Redmine、gateway、デモをまとめて起動します。

```bash
npm run feedback:redmine:local
```

runtime configは`/.well-known/feedback-redmine.json`、gatewayは同一originの
`/internal/feedback-redmine/v1`へproxyします。
デモもruntime loaderをtop-level `await`せず開始し、page破棄時は`AbortSignal`とcontrollerの両方をcleanupします。
