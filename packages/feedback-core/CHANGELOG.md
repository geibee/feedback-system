# Changelog

## 1.0.0-rc.3 - 2026-09-09

- RC.2で判明したOCI imageのbuild時刻依存を除去し、同一commitの再buildで同じdigestを生成する。公開APIと実行時挙動は変更しない。

## 1.0.0-rc.2 - 2026-09-08

- 削除済みの`manifest`、`telemetry`、`transport`出力が障害復旧時のRC.1 tarballへ混入した問題を修正し、現行sourceだけからclean buildする。

## 1.0.0-alpha.7 - 2026-08-30

- page／名前付きscroll領域へ追従するtargetを厳密に検証し、custom targetの新fallbackを追加しました。
- Redmineで使わないHTTP transport、manifest、telemetry、旧認証・参加者Host Adapter契約を削除しました。
- `FeedbackHostAdapter.subscribe`を任意契約として追加し、route／workspace変更をSDKへ通知できるようにしました。context再取得では`AbortSignal`を渡し、旧HTTP requestも中断します。
- `FeedbackTargetV1`の`custom` variantを厳密に検証し、任意rendererの対象を既存target resolverから返せるようにしました。

## 1.0.0-alpha.1

- framework 非依存の host adapter、transport、manifest/location/target API を追加。
- capabilities negotiation、Problem Details、token refresh、ETag、binary evidence に対応。
- manifest で `discard` 指定した query を browser 側 location からも除外。
