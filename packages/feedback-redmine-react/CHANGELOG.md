# Changelog

## Unreleased

- DOM captureを`@geibee/feedback-dom-capture`から再exportし、`@geibee/react`への依存を除去しました。
- DOM/画面/地図target、任意capture preview、返信、自己編集、履歴、15秒同期、responsive drawerを追加しました。
- 旧React版の2 launcher、対象選択bar、右クリックmenu、独立composer／Workspace一覧／drawer、pin外観と開閉操作を移植しました。
- capture成功時の自動添付と、詳細の明示的な証跡取得・画像表示を追加しました。
- Host Adapter未指定時の既定DOM captureと、保存画像へのFeedback位置ピン焼き込みを追加しました。
- thread deep linkを新規issueへ保存し、Profileによる明示無効だけをキャプチャ無効として表示するようにしました。
- `styles.css`からShadow DOM注入styleを生成し、配布CSSのdriftを検証するようにしました。
- `custom` targetをhostの既存pin position providerで追従し、未解決時は保存済みfallback座標へ表示するようにしました。

## 1.0.0-alpha.1

- 共通thread list、初回投稿、read-only drawer、polling、端末内follow/read badgeを追加。
