# 2026-09-07 live再検証

> 本書はalpha.2診断時点の履歴である。alpha.3の最終Jira／Backlog live Gateと正規verifyは[リリース準備記録](release-preparation-2026-09-07.md)でPASSしている。

対象sourceは`8ce8aac`。利用者が指定したJira Cloud開発siteとBacklog SaaS専用projectに対し、issue／comment／attachmentの作成・編集と今回作成したデータだけの削除について承認を受けて実行した。credentialはFIFOからprocess内へ読み込み、値を表示・保存していない。deployment、push、公開は行っていない。

## 初回の実測結果

| 検証 | 結果 | cleanup／証跡 |
| --- | --- | --- |
| `bash scripts/check-feedback-phase5-live.sh` | PASS、終了コード0 | 今回作成したissueの削除を確認。`tests/fixtures/jira-cloud-phase5/live-acceptance.json`を実測出力へ更新 |
| `node scripts/run-feedback-backlog-stage-a.mjs` | PASS（後続Stage Bへ進行） | 全run-owned issueの削除を確認。`tests/fixtures/backlog-stage-a/live-gate.json`を実測出力へ更新 |
| `bash scripts/check-feedback-backlog-live.sh` | FAIL、終了コード1 | 重複threadの回収結果が`completed`となりassertion失敗。成功証跡は更新していない |

Jira実測開始は`2026-09-07T00:41:43.679Z`、Backlog Stage A実測開始は`2026-09-07T00:43:26.395Z`。Stage Aのthread検索可視化は48,178 msであり、SLAではない。Backlog attachmentの一時IDと最終IDは引き続き一致せず、read／uploadの`unsupported`を維持する。

## Backlog Stage Bの失敗

同じthreadIdのissueを2件作成し、`waitForThreadCandidateCount(2, 3)`で3回連続の2候補を確認した後、別requestの`recoverIntent`が`repair_required`ではなく`completed`を返した。回収時の検索response件数は現runnerでは記録していないため、検索可視性の揺れか他の原因かをこの出力だけから断定しない。

Connectorの`recoverCreate`には0候補を`pending`、複数候補を`repair_required`へ閉じる分岐が存在する。今回の失敗を隠すretry、assertion緩和、永続cache、DB、既存issueへの変更を追加していない。

runnerの`finally`はcleanupを試みるが、先行assertion例外があると、その後のcleanup結果検査とJSON出力には到達しない。このためStage Bのcleanup完了は未確認として扱う。消費済みFIFOの再利用はせず、新しいBacklog credential FIFOによる追加のread-only確認が必要。

## 初回の正規検証

`bash scripts/verify-feedback.sh`をskip環境変数の指定なしで実行し、終了コード1を確認した。clean `npm ci`、Phase 0〜4、実Chrome smoke、Redmine package／契約、React 18／19 clean consumer、Redmine 5.1.12／6.0.10／6.1.3／7.0.0 container conformance、security、release、publish、container platformはPASSし、`[feedback-redmine-verify] PASS`まで到達した。

Phase 5は`保存済みBacklog Stage B live evidenceが現Connector実装へbindingされていません`で停止した。Jira live証跡の現source照合と15項目の契約checksum照合は通過した。Stage Bの保存済み証跡は旧実装digestのままであり、現修正のlive成功証跡として扱わない。後続のFeedback Service publish／release検査は正規入口から未到達であり、全Gate通過・リリース可とは判定しない。

ローカル検証log: `/tmp/feedback-live-reverify.36zonk/verify-feedback.log`。一時logはrepositoryへ含めない。

scoped testはBacklog Connectorの5件がPASS。provider acceptanceは14件中13件PASS、Stage B証跡digest不一致の1件がFAIL（終了コード1）。Stage Aの証跡bindingは更新後の実測値でPASSした。

Backlog scoped testの初回起動は、正規検証のclean `npm ci`と重なり`vitest: not found`（終了コード127）で実行できなかった。install完了後の再実行で5件のPASSを確認した。初回の未実行を成功件数には含めない。

## 新しいFIFOでの追加確認

`2026-09-07T01:33:06.947Z`に指定Backlog projectのissue一覧をread-onlyで取得した。取得件数0件、Stage B prefixに一致する残存issueも0件だった。この確認ではwrite／deleteを実行していない。

Stage B runnerへ匿名化診断を追加した。実際の`findThreadCandidatesById`の戻り件数をreply／revision／重複事前確認／重複回収の別に記録し、検索や回収結果は変更しない。`finally`では先行assertion失敗時にもcleanup対象件数・失敗件数・残存件数をstderrへ出し、成功証跡JSONとは分離する。provider ID、本文、credentialは診断へ出さない。公開契約、設定、Connector本体、Gateのassertion条件は変更していない。

重複回収の診断を追加した最初の再実行は、重複検証より前のreply回収が60秒を超過してFAIL（終了コード1）となった。`commentPostStarted=false`であり、このrunではreply POSTを送っていない。cleanup診断は対象1件・失敗0件・残存0件を記録した。`2026-09-07T01:36:23.694Z`の追加read-only一覧も0件だった。未送信操作を回収待ちする経路の特定のため、reply／revisionの実呼出しも診断対象へ加えた。

`2026-09-07T01:37:16.290Z`開始の次のrunでは、reply／revisionの実検索は各1候補で通過した。重複事前確認は1候補から2候補へ変わり、2候補を3回連続確認した。しかし直後の`recoverIntent`内部の検索は1候補であり、`completed`を返して元のassertion失敗を再現した。複数候補を受け取ってから1件を勝手に選ぶ分岐の不具合ではなく、別呼出しの候補集合を同一と仮定できないことが今回の直接原因である。providerの内部index構成や可視化上限まではこの観測から断定しない。

このrunは終了コード1、cleanup対象2件・失敗0件・残存0件だった。`2026-09-07T01:38:39.820Z`の追加read-only一覧でも0件を確認した。credentialを保持する一時processは終了し、秘密値をファイルへ保存していない。

前の検索での複数候補観測を、次のrequestでも必ず保持する保証は現在のstateless Connectorにはない。有限回の事前pollだけでその保証を追加したことにはできない。DB／永続cacheの追加やGateのassertion緩和は行わず、Backlog Stage Bは未通過とする。現行の「各検索の複数hitを拒否する」契約の検証と、「実際に重複が存在する限り検索可視性によらず拒否する」より強い保証を区別して、後続対応を決める必要がある。

## 診断追加後の最終検証

- `node --check scripts/run-feedback-backlog-live-conformance.mjs`: PASS。
- Backlog Connector scoped test: 5件PASS、終了コード0。
- provider acceptance: 14件中13件PASS、Stage Bの成功証跡digest不一致の1件FAIL、終了コード1。失敗runのdigestで成功証跡を更新していない。
- `bash scripts/verify-feedback.sh`: skip指定なしで再実行し、終了コード1。Phase 0〜4、実Chrome smoke、Redmine package／契約、React 18／19 clean consumer、4 version conformance、security、release／publish／container platformはすべてPASS。Phase 5のBacklog Stage B証跡bindingで停止した。Feedback Service publish／releaseは未到達。
- `git diff --check`: PASS。

最終logは`/tmp/feedback-backlog-diagnostic.BAvmyk/verify-feedback.log`。この追加確認では診断runnerと本記録のみを編集した。Redmine本体、公開契約、設定、既存の成功証跡は変更せず、commit／push／deployment／公開も行っていない。
