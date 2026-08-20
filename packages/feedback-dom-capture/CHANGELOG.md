# Changelog

## Unreleased

- legacy Feedback UIとRedmine UIで共有するDOM capture providerを追加しました。
- `img-src`で`data:`を拒否したCSPによる画像化失敗を、設定を特定できるエラーとして返すようにしました。
- mask selector対象を最終PNGへ直接黒塗りし、外部CSSへ依存しないfail-closedなマスク処理へ変更しました。
