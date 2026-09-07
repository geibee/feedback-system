# Changelog

## 未リリース - 2026-09-07

- 独立鍵ringによるAES-256-GCM threadReferenceの発行・検証、30日寿命、認可・scope束縛と検索fallback禁止を追加した。

## 未リリース - 2026-09-06

- profileの許可集合、remote自己編集のread／revise認可、日本語添付名のHTTP headerを修正した。

## 1.0.0-rc.1 - 2026-09-02

- provider非依存Service境界を維持したまま、runtime adapter registryからBacklog Connectorをrequest scopeで解決できるようにした。
- Backlog固有DTO、credential、provider分岐をServiceへ持ち込まず、DBレスtopologyとAuthorization Mode fallback禁止を維持した。

## 1.0.0-alpha.7 - 2026-08-31

- Phase 1のDBレスcomposition rootとfake profile loaderを追加した。
- Phase 2契約変更に追従し、DB、queue、persistent cache、upload storageを追加しない境界を維持した。
- Phase 3でread-only設定、3 Authorization Mode、participant credential、v1 facade guard、same-origin／CSRF／size／deadlineを検証するv2 HTTP adapterを実装した。
- Phase 5でpublic participant credentialをread／write request accessへ束縛し、認可済みrequest-scoped Connector resolverへ渡す実装portを追加した。
- `public-profile`専用のsame-origin participant credential発行routeを追加し、他Authorization Modeではfail-closedにした。
- intent回収hashを必須headerへ統一し、resource key上限をOpenAPIの512文字へ揃えた。
- readinessで署名key ring、participant ID導出鍵、Jira／Redmine provider credentialをparseし、不正secretを`ready: false`にした。
