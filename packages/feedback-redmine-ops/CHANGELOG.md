# Changelog

## Unreleased

- installation manifestの任意レビュー観点をclient profile生成へ反映するようにしました。
- ローカルdemoへsecretと分離した公開runtime config directoryをread-only mountし、ブラウザ再読み込みだけで案内を変更できるようにしました。

## 1.0.0-alpha.4

- npm tarball内の`feedback-redmine` CLIへ実行権限を付与し、`npm exec`／`npx`から直接起動できるようにした。

## 1.0.0-alpha.2

- 一コマンドのローカル評価、既存Redmineのrole／membershipを含むread-only診断、digest確認型provisioner、doctor、
  DB・files・ローカルsecretを同世代で扱うbackup／restoreの初版を追加。
