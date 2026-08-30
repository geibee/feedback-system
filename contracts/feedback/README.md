# @geibee/feedback-contracts

DBレスRedmine gatewayのOpenAPI 3.1、location/target、Redmine context/profile/model、runtime config、
既存Redmine installation/provision/inspectionのJSON Schemaと生成済みTypeScript型を提供する契約packageです。
GIS APIや特定ホストのroute型には依存しません。

```ts
import type { FeedbackLocationV1, FeedbackTargetV1 } from "@geibee/feedback-contracts";
```

OpenAPIは`@geibee/feedback-contracts/redmine-gateway.openapi.yaml`、各schemaは
`@geibee/feedback-contracts/schemas/*`から参照できます。
gateway HTTP契約とcontext attachmentはversion `1`で、unknown propertyを拒否します。
thread一覧は既存resource scopeと追加の`scope=workspace`を持ち、両方で`totalCount`を返します。scope省略は従来resource動作です。
正規化済みresponseは`schemas/redmine-model.schema.json`、Redmineへ保存するcontext attachmentは
`schemas/redmine-feedback-context.schema.json`を正本にします。principal sourceはsame-origin gatewayが注入する
`participant-credential`だけを許可し、browser profile UUIDを参加者IDとして保存します。
配備時公開設定は`schemas/redmine-runtime-config.schema.json`、名前ベースの導入宣言とplan/resultは
`schemas/redmine-installation-manifest.schema.json`、`schemas/redmine-provision-*.schema.json`を正本にします。
REST検査、15件の手動確認、承認digest、生成profileを含むread-only inspection出力は
`schemas/redmine-inspection-report.schema.json`を正本にし、credential fieldとunknown propertyを全階層で拒否します。
直接OIDC JWTはOpenAPIの`bearerAuth`に従い、固定語彙の`feedback_permissions`文字列配列を必須とします。
`npm run generate`はRedmine専用`src/redmine-gateway.generated.ts`を生成し、drift検査の対象にします。
registry が決まるまでは `private: true` のため、配布検証には repository 内の `npm pack` を使用します。
