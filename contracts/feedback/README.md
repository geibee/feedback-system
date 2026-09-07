# @geibee/feedback-contracts

DBレスFeedback v2とRedmine v1 gatewayのOpenAPI 3.1、domain／Envelope／provider profile、
既存Redmine context/profile/model、runtime config、installation/provision/inspectionのJSON Schemaと生成済みTypeScript型を提供する契約packageです。GIS APIや特定hostのroute型には依存しません。

```ts
import type { FeedbackLocationV1, FeedbackTargetV1 } from "@geibee/feedback-contracts";
import type { FeedbackThreadV2 } from "@geibee/feedback-contracts/v2";
import type { FeedbackEnvelopeV2 } from "@geibee/feedback-contracts/v2/server";
```

汎用v2 OpenAPIは`@geibee/feedback-contracts/feedback-gateway.openapi.yaml`、Redmine v1 OpenAPIは`@geibee/feedback-contracts/redmine-gateway.openapi.yaml`、各schemaは
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
汎用v2のAuthorization Modeはserver profileへ固定し、browser OpenAPIでmodeを選択しません。signed grantとremote authorizationのserver-side DTOはJSON Schemaを正本にし、attachment uploadは独立した`feedback:attachment:upload`を要求します。OpenAPIのsecurity schemeはsigned grant Bearerとpublic participant credential headerを記述する一方、server profileに合わないcredentialへfallbackしません。release blocker修正後の契約識別子は`feedback-v2-contract-2.0.0-alpha.2`で、public participant発行、unsafe operationのCSRF header、header束縛したintent回収、messageへ束縛したattachment markerを含みます。
`npm run generate`はv1／v2 OpenAPIとv2 JSON SchemaのTypeScript型を生成し、すべてdrift検査の対象にします。
registry が決まるまでは `private: true` のため、配布検証には repository 内の `npm pack` を使用します。

現行契約は `feedback-v2-contract-2.0.0-alpha.3`。[Thread Reference v1](./thread-reference.md)に従い、独立暗号鍵とopt-inを用いた参照固定を追加した。旧v2 JSONとRedmine v1は維持し、重複排除はbest-effortとする。
