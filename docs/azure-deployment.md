# Azure Container Appsへの配備

Feedback Systemは既存アプリと同じAzure Container Apps環境へ追加し、既存Azure Front Door Premiumを公開入口として使う。
利用者認証は既存OIDCまたは契約済みtoken exchangeを維持し、Microsoft Entra IDへの移行や認証無効化は行わない。
Entra IDはUser Assigned Managed IdentityによるACR、Key Vault、Azure Blobへのworkload認証にだけ使用する。

## 前提

- 既存のworkload profiles Container Apps環境がcustom VNetへ統合され、public network accessが無効である
- 既存のAzure Front Door PremiumとWAF、custom domain、ACRがある
- PostgreSQL delegated subnetとPrivate Endpoint専用subnetがある
- PostgreSQL、Blob、Key Vault用Private DNS zoneがContainer AppsのVNetへlink済みである
- Container Appsから既存OIDC issuer/JWKSと必要なconnectorだけへHTTPS egressできる
- Feedback ServiceとAdminのimageを既存ACRへpushし、Bicepにはtagではなくdigestを渡す

Azure Container Appsへ渡すimageは`linux/amd64`で生成する。ARM開発端末でもbuild stageは端末のarchitectureで実行し、
Service binaryだけを`TARGETARCH=amd64`へクロスコンパイルするため、QEMUは不要である。既存ACRへpushする例を次に示す。

```bash
docker buildx build \
  --platform linux/amd64 \
  --file apps/feedback-service-go/Dockerfile \
  --tag <acr-name>.azurecr.io/feedback-service:<version> \
  --push \
  .

docker buildx build \
  --platform linux/amd64 \
  --file apps/feedback-admin/Dockerfile \
  --tag <acr-name>.azurecr.io/feedback-admin:<version> \
  --push \
  .
```

push後はACRのmanifestで`os=linux`、`architecture=amd64`を確認し、解決したdigestを`serviceImage`と`adminImage`へ渡す。
ARM端末で通常の`docker build`を実行して作った`linux/arm64` imageをContainer Appsへ渡してはならない。

Front Door Standard、外部公開されたContainer Apps環境、Microsoft管理VNetのConsumption-only環境はこのtemplateの本番前提を
満たさない。対象アプリ側の基盤を先に更新し、Feedbackだけ別の公開経路へ迂回させない。

## Bicepの境界

`deploy/azure/main.bicep`は既存Container Apps環境とACRを参照し、Feedback専用のPostgreSQL Flexible Server、Storage
Account、Key Vault、Managed Identity、API/worker/jobを作成する。既存VNet、Front Door、ACRを所有または再作成しない。

主な入力は次のとおりである。

- 既存Container Apps環境とACRのsubscription/resource group/name
- PostgreSQL delegated subnet、Private Endpoint subnet、3つのPrivate DNS zoneのresource ID
- OIDC issuer/audience/JWKS URLと、使用する場合だけtoken exchange設定
- digest固定したService/Admin image
- bootstrapするtenant/application/environment/workspaceと管理主体
- DB passwordとnotification暗号鍵のsecure parameter

secure parameterは承認済みdeployment pipelineのsecret storeまたは既存Key Vault参照から注入する。parameter file、shell引数、
deployment output、ログへ平文を保存しない。templateは受け取った値をFeedback専用Key Vaultへ保存し、Container Appsには
version固定のKey Vault secret referenceだけを設定する。

`deploy/azure/front-door.bicep`はFront Doorのresource groupへ別deploymentとして適用する。Feedback API用origin group、
`/health/ready` probe、Container Apps managed environmentへのPrivate Link origin、`/feedback/v1/*` routeを追加する。
Adminを有効にする場合は専用hostnameのcustom domainを渡し、別origin/routeを追加する。既存custom domain resource IDを明示し、
default Front Door domainは有効化しない。Private Link要求はContainer Apps環境側で承認してからrouteを利用する。

## 段階配備

1. `runtimeEnabled=false`で`main.bicep`をwhat-if後に配備する。API/Admin/workerは0 replicaのまま、data resource、identity、
   migration/bootstrap jobだけを作成する。
2. `az containerapp job start`で出力されたmigration jobを1回実行し、executionがSucceededであることを確認する。失敗時は
   runtimeを有効化せず、job logとDB migration履歴を保全する。
3. 初回だけbootstrap jobを実行する。複数workspaceはparameterを変更して同じ冪等jobを順番に実行する。
4. `runtimeEnabled=true`で再配備し、API 2 replica、各worker 1 replica、Admin 1 replicaを起動する。
5. APIの`/health/ready`がDB、Evidence Blob、Export Blobをすべてreadyと報告することを内部経路から確認する。
6. `front-door.bicep`をwhat-if後に配備し、Private Link要求を承認する。Front Door経由のreadyと実OIDC tokenによるAPI操作を
   確認してからrouteを有効な変更として扱う。

`bootstrapEnabled=false`を通常運用の既定とする。Keycloak、MinIO、reference broker、conformance consumerはローカルfixtureで
ありAzureへ配備しない。connector runtime/registerも既定では配備せず、実際のprovider、内部Ingress、永続台帳、secret、
egress allowlistを決めた場合だけ別変更で追加する。

## RBACと監視

- API identity: Evidence container contributor、Export container reader
- Export worker identity: Evidence reader、Export contributor
- Retention worker identity: Evidence/Export contributor
- Notification/migration identity: Blob権限なし
- image pull identity: 既存ACRの`AcrPull`
- 各runtime identity: 必要なKey Vault secretを参照する`Key Vault Secrets User`

Container AppsのJSON stdout/stderr、revision状態、probe失敗、PostgreSQL接続数、Storage availability、worker backlog、delivery
failure、backup checksum、retention、audit件数を既存監視基盤へ送る。`/metrics`をFront Door routeへ公開しない。

## 検証とrollback

ローカル品質ゲートはBicep compileを含む。

```bash
bash scripts/verify-feedback.sh
```

Azure stagingではEvidence upload/download/delete、Export生成・取得、backup、retention、migration/bootstrap再実行、OIDCの
正しいissuer/audienceと誤ったaudience、Managed IdentityのRBAC不足時のreadiness失敗を確認する。PostgreSQL、Storage、
Key Vaultのpublic endpointとContainer Apps既定FQDNへ外部から直接到達できないことも確認する。

application rollbackはContainer Appsの直前revisionへ戻し、workerを0 replicaにしてstale lease回収後に再開する。DB migrationを
逆適用しない。migration前にPostgreSQL PITR、Export containerのbackup checksum、使用image digestを変更記録へ残す。
