# Feedback Service Runtime

`@geibee/feedback-service`、Jira Cloud／Redmine／Backlog Connector、production Envelope verifier、Node.js listenerを接続するdeploy artifactである。provider固有のprofile parser、credential wire変換、capability、repository factoryはadapter registryへ登録し、Feedback Service本体のprovider非依存境界を変更しない。

このruntimeはDB、queue、persistent／shared application data cache、upload directory、private object storage、ホストDBを使用しない。設定fileはread-only、credentialと署名鍵はserver-side環境変数から解決する。

起動前に`FEEDBACK_SERVICE_SETTINGS_FILE`、`FEEDBACK_CONNECTOR_PROFILES_FILE`、`FEEDBACK_PUBLIC_ORIGIN`と、provider profileが参照するsecretを設定し、依存packageをbuildする。

```sh
npm run build:feedback:v2
npm --workspace @geibee/feedback-service-runtime run start
```

release候補はrootと全workspaceを同じversionへ揃えたsourceからmulti-architecture OCIとして生成する。生成物にはBacklog Connectorを含むruntime、CycloneDX SBOM、HIGH／CRITICAL脆弱性report、checksum、live evidence bindingを持つmanifestが含まれる。

```sh
bash scripts/build-feedback-service-release.sh \
  --output /tmp/feedback-service-1.0.0-rc.2 \
  --version 1.0.0-rc.2
```

standalone listenerは`public-profile`と`signed-grant`を扱う。`remote-authorization`は認証済みsubjectを供給するhost adapterが必要なため、adapterなしでは起動をfail-closedにする。任意HTTP headerをsubjectとして信頼しない。

`GET /healthz`はprocess liveness、`GET /readyz`は設定とsecret解決のreadinessである。Backlog profileだけはproject、4 Text custom field、issue type、priorityのprovisioningをAPIで確認し、不一致または到達不能時はreadyにしない。provider障害中のoffline readは保証しない。
