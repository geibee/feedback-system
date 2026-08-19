# Azure deployment assets

本directoryのBicepは既存アプリのAzure基盤へFeedback Systemを追加するための部品である。単独の公開基盤は作らない。

- `main.bicep`: Feedback専用data resource、Managed Identity、Container Apps、manual job
- `workloads.bicep`: API/Admin/worker/migration/bootstrapのrole別定義
- `acr-pull.bicep`: 既存ACR resource groupへ`AcrPull`を割り当てるcross-scope module
- `front-door.bicep`: 既存Front Door PremiumへPrivate Link originとAPI routeを追加する別deployment

前提、secret注入、段階配備、受入試験は[`docs/azure-deployment.md`](../../docs/azure-deployment.md)を参照する。
