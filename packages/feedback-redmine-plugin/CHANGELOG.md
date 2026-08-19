# Changelog

## 1.0.0-alpha.1

- Shadow DOM mount facade、same-origin gateway transport、browser storage fallback、self-hosted ESM bundleを追加。
- browser配布物のsource mapを無効化し、clean buildで古いartifactを残さないようにした。
- secretや業務本文を含まない最大100件のmemory diagnosticと明示download handleを追加。
- draft/pending intentをhost principal scopeで分離し、期限切れintentを自動削除。
