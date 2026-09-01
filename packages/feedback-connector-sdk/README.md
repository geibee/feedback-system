# @geibee/feedback-connector-sdk

Connectorとgatewayの間で使うserver-only `FeedbackRepositoryPort`、`ProviderRef`、stream契約です。projectionは候補抽出だけに使用し、`readCandidate`後のEnvelope署名、provider binding、scope、現在認可、profile policy、backend capability検証をgatewayが完了するまでbrowser DTOへ変換しません。

`@geibee/feedback-connector-sdk/testing`はrecording fakeと共通Connector TCKを提供します。本番Connector実装はPhase 3で行います。
