# @geibee/feedback-connector-redmine

Feedback v2のRedmine production Connectorです。公開契約`feedback-v2-contract-2.0.0-alpha.1`を実装し、ticket、journal、attachmentとcustom fieldだけからthreadを再構築します。DB、queue、永続cache、upload directory、private object storageは使用しません。

`createFeedbackRedmineConnector()`へrequest scopeに固定したprofile、署名codec、`FeedbackRedmineTransportPort`を注入します。標準REST実装は`createFeedbackRedmineRestTransport()`です。API credentialはserver-side secretから解決し、browser configへ含めないでください。

issue作成の最初のPOSTへ`threadId`、`intentId`、`requestHash`を同時保存し、object ID取得後にEnvelope、projectionを順に保存します。0 hitは`pending`、複数hitは`repair_required`です。reply／revisionは既存v1 message metadata内へ署名済みv2 markerを追加するため、v1 readerの本文とv2 readerのeventが重複しません。attachment binaryは一回だけ送信し、結果不明時は`manual-confirmation`へ閉じます。

`feedbackRedmineV2ProvisioningFields`と`planRedmineV2Provisioning()`はops用のcustom field要件と競合planを返します。Connector runtimeは設定変更を行わず、`assertFeedbackRedmineProfile()`で適用済みfield IDをfail-closed検証します。

`ops/feedback_redmine_v2_custom_fields.rb`は既存v1 fieldを変更しない独立Rails runnerです。plan digestを確認したapplyでのみv2専用3 fieldを作成します。利用手順は`ops/README.md`を参照してください。
