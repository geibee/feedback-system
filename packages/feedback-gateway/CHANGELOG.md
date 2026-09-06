# Changelog

## 未リリース - 2026-09-06

- profile取得時に現在の認可・policy・backend能力による許可集合を返し、任意の拒否operationを必須にしない。

## 1.0.0-alpha.7 - 2026-08-31

- 3つのAuthorization Mode、profile loader、projection verifierを含むPhase 1 contract skeletonを追加した。
- Phase 2でprofile／workspace／resource authorization target、mode固定selector、recording fake、権限積集合とraw projection検証境界を固定した。
- Phase 3でgateway application service、discovery、command／intent回収、provider直接再読込後のprojection検証を実装した。
- Phase 5でAuthorization Mode検証後だけ呼ぶrequest-scoped Connector resolver実装portを追加し、既存static registry互換を維持した。
