# Changelog

## 1.0.0-alpha.7 - 2026-08-30

- page／名前付きscroll領域へ追従するtargetを厳密に検証し、custom targetの新fallbackを追加しました。
- Redmineで使わないHTTP transport、manifest、telemetry、旧認証・参加者Host Adapter契約を削除しました。
- `FeedbackHostAdapter.subscribe`を任意契約として追加し、route／workspace変更をSDKへ通知できるようにしました。context再取得では`AbortSignal`を渡し、旧HTTP requestも中断します。
- `FeedbackTargetV1`の`custom` variantを厳密に検証し、任意rendererの対象を既存target resolverから返せるようにしました。

## 1.0.0-alpha.1

- framework 非依存の host adapter、transport、manifest/location/target API を追加。
- capabilities negotiation、Problem Details、token refresh、ETag、binary evidence に対応。
- manifest で `discard` 指定した query を browser 側 location からも除外。
