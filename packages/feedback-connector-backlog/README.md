# Feedback Backlog Connector

Backlog API v2を既存`FeedbackRepositoryPort`へ写像するserver-side Connectorである。本文、recovery seed、署名済みEnvelope、comment markerはBacklogだけへ保存し、補助DBやobject storageを使用しない。

create、reply、append-only revisionはprovider検索による回収を行う。Backlogの一時attachment IDと最終issue attachment IDは一致しないため、attachment read／uploadはfail-closedに`unsupported`である。

runtime profileは専用Text custom field `feedback.threadId`、`feedback.intentId`、`feedback.requestHash`、`feedback.resourceKey`のIDを要求する。最初の3 fieldはcreate回復triplet、4つ目はresource単位のthread検索projectionであり、いずれも署名済みEnvelopeの代替ではない。

custom field定義APIの`typeId`とissue DTO内の`fieldTypeId`はBacklog REST client内で別々に検証する。検索はproviderのKeyword結果を完全一致で再filterし、0件を`pending`、複数件を`repair_required`とする。
