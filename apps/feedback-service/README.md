# Feedback Service

DB、queue、persistent／shared application data cache、upload directory、private object storageを持たないprovider非依存Feedback Serviceです。Web標準`Request`／`Response`のv2 HTTP adapter、3つのAuthorization Mode、read-only設定、participant credential、v1 facade認可guardを実装します。Phase 5のnetwork listenerとprovider別Connector配線は別artifactの`@geibee/feedback-service-runtime`が所有します。

非secret設定は`feedback-service-settings.v2`、provider profileは`feedback-provider-profile.v2`を正本とし、credentialと署名鍵はserver-side secret referenceだけで解決します。

HTTP adapterはsame-origin、CSRF、content type、stream request size、hard deadlineをfail-closed検証します。Jira CloudのForge entity property index artifactは`@geibee/feedback-connector-jira-cloud`にだけ付属し、このapplicationへ組み込みません。

Gatewayが認可を完了した後、request accessへ束縛されたparticipant principalをproduction Connector factoryへ渡します。static Connector mapはtest／互換composition用で、Authorization Modeのfallbackには使用しません。
