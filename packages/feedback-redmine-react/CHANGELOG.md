# Changelog

## 1.0.0-alpha.7 - 2026-09-01

- `FeedbackControllerPort`へ接続する`RedmineFeedbackControllerOverlay`互換wrapperを追加しました。
- 既存`RedmineFeedbackOverlay`とv1 UI characterizationはlegacy互換entry pointとして維持します。

## 1.0.0-alpha.7 - 2026-08-30

- v2 dual-write ticketのUUIDv7／UUIDv8 thread／message IDを既存overlayで保持するようにしました。
- 既存`custom` targetのDOM座標metadataを使い、keyのないpinをpage scrollへ、`data-feedback-scroll-key`のpinを領域scrollへ追従させました。
- スクリーンショットのピン座標を選択時点で固定し、非同期capture中のscrollによるずれを防止しました。
- Redmine変更履歴を既定で折りたたみ、主画像の操作名を「画面キャプチャを表示」へ変更しました。
- 投稿画面へ管理者案内と、profileでopt-inした親チケット・期限・重要度を追加しました。

- Redmine認証失敗時にSPA利用者へgateway設定の管理者確認を案内するよう変更しました。
- capture診断の警告表示を追加しました。

- DOM captureを`@geibee/feedback-dom-capture`から再exportし、`@geibee/react`への依存を除去しました。
- DOM/画面/地図target、任意capture preview、返信、自己編集、履歴、15秒同期、responsive drawerを追加しました。
- 2 launcher、対象選択bar、右クリックmenu、独立composer／Workspace一覧／drawer、pin外観と開閉操作を追加しました。
- capture成功時の自動添付と、詳細の明示的な証跡取得・画像表示を追加しました。
- Host Adapter未指定時の既定DOM captureと、保存画像へのFeedback位置ピン焼き込みを追加しました。
- thread deep linkを新規issueへ保存し、Profileによる明示無効だけをキャプチャ無効として表示するようにしました。
- `styles.css`からShadow DOM注入styleを生成し、配布CSSのdriftを検証するようにしました。
- `custom` targetをhostの既存pin position providerで追従し、未解決時は保存済みfallback座標へ表示するようにしました。

## 1.0.0-alpha.1

- 共通thread list、初回投稿、read-only drawer、polling、端末内follow/read badgeを追加。
