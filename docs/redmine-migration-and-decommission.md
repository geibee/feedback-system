# Redmine移行・旧Feedback runtime廃止

## 現在の範囲

Redmine正本clientはfresh導入を対象とし、旧Feedback Serviceのthread、message、evidenceを自動移行しない。
W9のone-shot migration CLIは本変更に含まれていない。旧データが存在する環境で、Redmineを有効化しただけで旧runtimeを停止・削除してはならない。

旧データがない場合はRedmine projectを新しい正本として開始し、従来のFeedback Service routeを新clientへ混在させない。
旧データが必要な場合は、移行CLIを別変更として設計・実装・検証するまで旧runtimeをreadableに維持する。

## 将来のone-shot移行要件

移行を実装する場合は、通常runtimeではなく承認されたone-shot toolとし、次を満たす。

- sourceをread-onlyで読み、destination Redmine URL/project/tracker/custom field mappingを明示する
- 旧thread UUIDを`Feedback Thread ID`へそのまま保存する
- 初回messageをissue description、後続messageを時系列journalへ変換する
- location/target/author/releaseを`feedback-context-v1.json`へ保存する
- evidenceをhash・size・content type検証後にattachmentへ保存する
- issue作成前にthread IDを検索し、同一request hashだけを冪等回収する
- duplicate、欠損証跡、非対応content typeを監査reportへ出してfail-closedする
- secret、API key、message本文、evidence bytesをlogへ出さない

移行完了は件数一致だけで判断せず、description、全journal、attachment hash、custom field、context再構築を照合する。
移行toolが未実装または未検証なら「移行不要」または「移行完了」と記録しない。

## 切替checklist

1. Redmine backupとrestore試験を完了する。
2. project/tracker/role/custom field/integration userを確定する。
3. gatewayまたは拡張機能のread検証を行う。
4. canary issueでwrite、冪等回収、journal、attachment downloadを確認する。
5. 旧データがある場合は承認済みmigration reportと例外一覧を確認する。
6. clientをRedmine経路へ切り替え、旧Serviceへの新規writeを停止する。
7. 観測期間中は旧Serviceとstorageをread-onlyで保持する。
8. Redmineだけから代表threadを再構築し、利用者・管理者が承認する。
9. retention、法務、rollback期間を満たしてから旧runtime廃止を別作業として承認する。

## 廃止対象と保持対象

Redmine正本方式だけを採用した環境では、旧Feedback API、PostgreSQL、object storage、export/notification worker、Admin Consoleを
runtime依存にしない。ただし他applicationが従来方式を利用中なら共有資源を削除してはならない。

保持するもの:

- Redmine DB/files backupとrestore手順
- client/gateway/extension artifactと対応version
- server/extension profileからsecretを除いた構成履歴
- 移行した場合の件数・hash・例外report
- 旧runtimeのrollback artifactを保持期間終了まで

削除は対象application、database、bucket/prefix、credentialをread-only inventoryで特定し、owner承認とrecoverabilityを確認してから行う。
このrepositoryの通常検証やRedmine導入scriptは旧データを削除しない。
