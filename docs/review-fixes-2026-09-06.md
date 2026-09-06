# 2026-09-06 レビュー指摘の修正

## 互換性と廃止範囲

旧DB保存版は廃止済み。現repositoryのRedmine `legacy` readerは現行Redmine v1 ticket形式を読むものであり、DB版ではない。DB用adapter、接続設定、migration、永続storeを復活させていない。Redmine v1のOpenAPI・保存形式・公開package・browser storage keyは変更していない。

v2の旧Envelopeには初期本文のhashがない。この本文はprovider由来として表示し、検証済み本人本文としての自己編集は許可しない。署名済みの既存revisionは検証して最新本文と所有者を再構築する。詳細は[API互換性](api-compatibility.md)と[ADR 0003](adr/0003-envelope-canonicalization-and-key-separation.md)を参照。

## 修正内容

| 指摘 | 修正と回帰検証 |
| --- | --- |
| 未検証legacy markerによるv2上書き | v1 journalはprovider由来として保持し、v2 messageへ適用しない。偽署名markerの反例を追加 |
| profileがreadのみ返す | 認可・policy・backend能力による許可集合を照会。匿名public profileとremote部分許可を検証 |
| remote自己編集503 | 所有者確認のreadとreviseを別々に認可。read拒否時にwriteしない反例を追加 |
| Redmine末尾改行でhash不一致 | v1と同じ正規化をreply／revisionの署名と保存へ適用。CRLF・空行・末尾空白を検証 |
| 初期本文の改変 | server-only Envelopeへ任意initialBodyHashを追加。3 Connectorで本文照合し、field削除downgradeも拒否 |
| 切断時intent喪失 | 通信前に保存し、disconnect後の再接続でも保持。保存例外時の送信禁止を検証 |
| 日本語添付名502 | ASCII fallbackとUTF-8 filename*を生成。実HTTP adapterでbinary取得を検証 |
| Backlog障害でnot ready | readinessから疎通検査を分離。ローカル設定・secret形式検証と配備前provisioning検査は保持 |
| demo脆弱性検査失敗 | 既存apk upgrade対象へlibuuidを追加。修正後のRedmine release検査がPASS |

Controller → HTTP client → Service → Gateway → Jira Connector → projection verifierの実装経路で、通常投稿と応答喪失後の明示回収を検証する。providerはin-memory transport、HTTPは実Serviceへのin-process bridgeを使用し、Controller／Service／Connector本体はmockしない。旧DBをfixtureとして使用しない。

## 正規検証

最終ソースで変更対象8 packageのtypecheckと164件のtestがPASS。Controller／client／Service／Jiraの統合2件とprovider acceptance packageのtypecheckもPASS。`git diff --check`と現行契約checksum照合もPASS。

`bash scripts/verify-feedback.sh`をskip指定なしで実行した。Phase 0〜4、browser smoke、Redmine 5.1.12／6.0.10／6.1.3／7.0.0 conformance、Redmine release／publish／container platform検査はPASS。以前のdemo脆弱性検査による停止は解消した。

全体の終了コードは1。Phase 5のJira live evidenceと現sourceのdigest不一致で停止した。検査を弱めたり、実行なしでlive evidenceのdigest・booleanを更新したりしていない。公開契約の現checksumはschema／OpenAPI修正へ同期したが、外部実測の証跡とは区別する。

provider acceptance全suiteは14件中12件PASS、2件FAIL。FAILはBacklog Stage A／Bの保存済みlive evidenceと現sourceのdigest不一致。Service release OCI検査は正規入口から未到達。これは修正後の全Gate通過を意味しない。

## 実環境で必要な再検証

- Jira: `scripts/check-feedback-phase5-live.sh`。管理site内でrun-owned issue／comment／attachmentを作成し、試験後にrun-owned issueを削除する。
- Backlog Stage A: `scripts/run-feedback-backlog-stage-a.mjs`。契約・署名形式の変更に伴う再実測。run-owned issue／comment／試験attachmentの操作とcleanupを含む。
- Backlog Stage B: `scripts/check-feedback-backlog-live.sh`。実Connectorのcreate／reply／revision回収、別process再構築、attachment unsupported、run-owned issue cleanupを確認する。
- 上記の実測証跡を正規手順で更新後、`bash scripts/verify-feedback.sh`を再実行する。

この修正作業では外部providerへのwrite、deployment、pushは実行していない。再実測には対象siteでの操作承認と、新しいFIFOによるcredential引渡しが必要。
