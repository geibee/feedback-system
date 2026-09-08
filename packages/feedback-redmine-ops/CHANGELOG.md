# Changelog

## 1.0.0-rc.3 - 2026-09-09

- RC.2で判明したOCI imageのbuild時刻依存を除去し、同一commitの再buildで同じdigestを生成する。公開APIと実行時挙動は変更しない。

## 1.0.0-rc.2 - 2026-09-08

- RC.1 release集合のstale build混入を解消するclean rebuild。CLIの公開契約と実行時挙動は変更しない。

## 1.0.0-alpha.7 - 2026-08-30

- installation manifestの任意レビュー観点をclient profile生成へ反映するようにしました。
- ローカルdemoへsecretと分離した公開runtime config directoryをread-only mountし、ブラウザ再読み込みだけで案内を変更できるようにしました。

## 1.0.0-alpha.4

- npm tarball内の`feedback-redmine` CLIへ実行権限を付与し、`npm exec`／`npx`から直接起動できるようにした。

## 1.0.0-alpha.2

- 一コマンドのローカル評価、既存Redmineのrole／membershipを含むread-only診断、digest確認型provisioner、doctor、
  DB・files・ローカルsecretを同世代で扱うbackup／restoreの初版を追加。
