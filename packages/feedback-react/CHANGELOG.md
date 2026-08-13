# Changelog

## Unreleased

- Thread Drawerのthread切替時に古い証跡previewを破棄し、切替前の遅延responseが現在のpreviewを上書きしないようにしました。
- Drawerを閉じた時、threadを切り替えた時、Overlayを破棄した時に証跡のBlob URLを解放するようにしました。

## 1.0.0-alpha.1

- Provider、Overlay、DOM/screen pin、Thread Drawer、locale/theme/portal拡張点を追加。
- 投稿、返信、編集履歴、resolve/reopen、private evidence preview、deep link navigation に対応。
- exclude/mask、capture失敗時のコメント投稿継続、unavailable分離を追加。
- DOM/screen pin を page/route/path/query が一致する thread だけに限定。
- Feedback Buttonの対象選択、右クリックmenu、投稿一覧、座標追従pin、証跡previewを追加。
- 投稿者名と画面別レビュー観点を扱う投稿画面、レビュー案内、responsiveなpanel／button styleを追加。
- Thread Drawerや投稿一覧を開いている間も画面上のpinを維持し、選択中threadを強調表示。
- `data-feedback-map`領域のclick／右クリックを画面座標へfallbackし、host固有target resolverを追加。
