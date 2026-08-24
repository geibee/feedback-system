# Legacy Feedback ServiceのAzure配備

このdirectoryは、既存のAzure Container Apps環境とAzure Front Door PremiumへLegacy Feedback Serviceを追加するためのBicepです。Redmine構成では使用しません。

新しいAzure基盤は作りません。次が既にある環境だけが対象です。

- custom VNetへ統合したworkload profiles Container Apps環境
- Azure Front Door Premium、WAF、custom domain
- ACR
- PostgreSQL delegated subnetとPrivate Endpoint subnet
- PostgreSQL、Blob、Key VaultのPrivate DNS zone

## 1. templateを検証する

```bash
bash scripts/verify-feedback-azure.sh
```

## 2. imageをACRへpushする

Container Apps用に`linux/amd64`でbuildします。

```bash
export LEGACY_RELEASE_VERSION='1.0.0-rc.1'
export LEGACY_ACR='<acr-name>.azurecr.io'

docker buildx build \
  --platform linux/amd64 \
  --file apps/feedback-service-go/Dockerfile \
  --tag "${LEGACY_ACR}/feedback-service:${LEGACY_RELEASE_VERSION}" \
  --push \
  .

docker buildx build \
  --platform linux/amd64 \
  --file apps/feedback-admin/Dockerfile \
  --tag "${LEGACY_ACR}/feedback-admin:${LEGACY_RELEASE_VERSION}" \
  --push \
  .
```

ACRから解決したdigestをparameter fileの`serviceImage`と`adminImage`へ指定します。tagだけを指定しないでください。

## 3. data resourceとjobを配備する

`main.bicep`のparameterを組織のsecure parameter fileへ設定します。DB passwordとnotification暗号鍵はpipelineのsecret storeまたはKey Vault参照から渡し、Gitやshell履歴へ値を書きません。

最初は`runtimeEnabled=false`、初回resourceを作る場合は`bootstrapEnabled=true`にします。

```bash
export LEGACY_RESOURCE_GROUP='<feedback-resource-group>'
export LEGACY_DEPLOYMENT='feedback-legacy'
export LEGACY_PARAMETERS='/secure/feedback-azure.parameters.json'

az deployment group what-if \
  --resource-group "${LEGACY_RESOURCE_GROUP}" \
  --name "${LEGACY_DEPLOYMENT}" \
  --template-file deploy/azure/main.bicep \
  --parameters "@${LEGACY_PARAMETERS}" \
  --parameters runtimeEnabled=false bootstrapEnabled=true

az deployment group create \
  --resource-group "${LEGACY_RESOURCE_GROUP}" \
  --name "${LEGACY_DEPLOYMENT}" \
  --template-file deploy/azure/main.bicep \
  --parameters "@${LEGACY_PARAMETERS}" \
  --parameters runtimeEnabled=false bootstrapEnabled=true
```

出力されたmigration jobを実行します。

```bash
LEGACY_MIGRATION_JOB="$(
  az deployment group show \
    --resource-group "${LEGACY_RESOURCE_GROUP}" \
    --name "${LEGACY_DEPLOYMENT}" \
    --query properties.outputs.migrationJobName.value \
    --output tsv
)"

az containerapp job start \
  --resource-group "${LEGACY_RESOURCE_GROUP}" \
  --name "${LEGACY_MIGRATION_JOB}"

az containerapp job execution list \
  --resource-group "${LEGACY_RESOURCE_GROUP}" \
  --name "${LEGACY_MIGRATION_JOB}" \
  --output table
```

executionが`Succeeded`にならない場合はruntimeを有効化しません。初回resourceを作る場合だけ、同様に出力`bootstrapJobName`のjobを1回実行します。

## 4. runtimeを起動する

```bash
az deployment group create \
  --resource-group "${LEGACY_RESOURCE_GROUP}" \
  --name "${LEGACY_DEPLOYMENT}" \
  --template-file deploy/azure/main.bicep \
  --parameters "@${LEGACY_PARAMETERS}" \
  --parameters runtimeEnabled=true bootstrapEnabled=false
```

API FQDNを出力から取得し、private network内からreadyを確認します。

```bash
az deployment group show \
  --resource-group "${LEGACY_RESOURCE_GROUP}" \
  --name "${LEGACY_DEPLOYMENT}" \
  --query properties.outputs.apiFqdn.value \
  --output tsv
```

## 5. Front Door routeを追加する

`front-door.bicep`用parameter fileへ、上のdeploymentが出力したAPI／AdminのFQDNとresource IDを設定します。

```bash
az deployment group what-if \
  --resource-group '<front-door-resource-group>' \
  --name feedback-legacy-front-door \
  --template-file deploy/azure/front-door.bicep \
  --parameters @/secure/feedback-front-door.parameters.json

az deployment group create \
  --resource-group '<front-door-resource-group>' \
  --name feedback-legacy-front-door \
  --template-file deploy/azure/front-door.bicep \
  --parameters @/secure/feedback-front-door.parameters.json
```

Container Apps環境側でFront DoorのPrivate Link要求を承認し、Front Door経由の`/health/ready`と実際のOIDC tokenによるAPI操作を確認します。

## templateの役割

| ファイル | 作成するもの |
| --- | --- |
| `main.bicep` | Feedback専用DB、Blob、Key Vault、Managed Identityとworkload |
| `workloads.bicep` | API、Admin、worker、migration／bootstrap job |
| `acr-pull.bicep` | 既存ACRの`AcrPull`割当て |
| `front-door.bicep` | 既存Front Door PremiumのPrivate Link originとroute |
