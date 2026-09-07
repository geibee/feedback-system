# @geibee/feedback-client

汎用v2 wire契約をcontrollerから隠蔽するbrowser向け`FeedbackClientPort`です。`createFeedbackHttpClient`はsame-origin相対path、JSON／problem mapping、multipart upload、stream downloadを実装し、HTTP retryは行いません。実際のI/Oは`FeedbackHttpTransport`へ注入でき、`createFetchFeedbackTransport`でWeb標準fetchへ適合できます。すべてのPOSTへ`X-Feedback-CSRF: 1`を付与します。

公開型は`@geibee/feedback-contracts/v2`の生成型を参照し、provider IDや`ProviderRef`を公開しません。

結果不明のupload sourceは一度だけ消費します。`202 IntentRecoveryResult`はcontrollerへそのまま返し、transportがbinaryを再送することはありません。

`credentialProvider`はrequestごとに`profileId`、任意のworkspace／resource、operationを受け取り、signed-grant用Bearerまたはpublic-profile write用participant credentialの一方だけを返します。`remote-authorization`ではproviderを省略し、fetchのsame-origin credentialsだけを使用します。

`public-profile`では最初に`issueParticipant`へ端末内で生成したbrowser profile UUIDを渡し、返されたcredentialを同じprofileの`credentialProvider`からwrite requestへ付与します。発行endpointはsame-origin／CSRF検証を通り、`signed-grant`や`remote-authorization`へfallbackしません。
