# 変更履歴

## 1.0.0-rc.3 - 2026-09-09

- RC.2で判明したOCI imageのbuild時刻依存を除去し、同一commitの再buildで同じdigestを生成する。公開APIと実行時挙動は変更しない。

## 1.0.0-rc.2 - 2026-09-08

- RC.1 release集合のstale build混入を解消するclean rebuild。公開APIと実行時挙動は変更しない。

## 1.0.0-alpha.7 - 2026-08-30

- keyのない選択位置を既存`custom` targetのdocument座標metadataへ保存し、`data-feedback-scroll-key`付き領域ではcontent座標metadataへ保存するようにしました。

## 1.0.0-alpha.2

- DOM target解決とFeedback用DOM属性名を共通化した。
