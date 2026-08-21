# Changelog

## Unreleased

- DOM capture実装を`@geibee/feedback-dom-capture`へ分離し、既存APIを後方互換のため再exportするようにしました。
- `FeedbackHostAdapter.subscribe`を購読し、route／workspace変更時に進行中のcontext HTTP requestを`AbortSignal`で中断して再取得するようにしました。
- context変更時にOverlayの選択、投稿、thread表示stateを閉じ、変更前画面の操作を持ち越さないようにしました。
- `FeedbackOverlay.pinPositionProvider`を追加し、hostが解決した`map-position`／`map-feature`を通常の番号付きpinとして表示できるようにしました。
- Thread Drawerを選択中pinの反対側へ配置し、狭い画面では地図を残すコンパクトな下部sheetへ切り替えるようにしました。
- Thread Drawerのthread切替時に古い証跡previewを破棄し、切替前の遅延responseが現在のpreviewを上書きしないようにしました。
- Drawerを閉じた時、threadを切り替えた時、Overlayを破棄した時に証跡のBlob URLを解放するようにしました。
- `custom` targetをhostの既存pin position providerで追従し、未解決時は保存済みfallback座標へ表示するようにしました。

## 1.0.0-alpha.1

- Provider、Overlay、DOM/screen pin、Thread Drawer、locale/theme/portal拡張点を追加。
- 投稿、返信、編集履歴、resolve/reopen、private evidence preview、deep link navigation に対応。
- exclude/mask、capture失敗時のコメント投稿継続、unavailable分離を追加。
- DOM/screen pin を page/route/path/query が一致する thread だけに限定。
- Feedback Buttonの対象選択、右クリックmenu、投稿一覧、座標追従pin、証跡previewを追加。
- 投稿者名と画面別レビュー観点を扱う投稿画面、レビュー案内、responsiveなpanel／button styleを追加。
- Thread Drawerや投稿一覧を開いている間も画面上のpinを維持し、選択中threadを強調表示。
- `data-feedback-map`領域のclick／右クリックを画面座標へfallbackし、host固有target resolverを追加。
