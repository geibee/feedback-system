# Backlog Connector release candidate

## 対象

monorepo version `1.0.0-rc.1`を最初のBacklog release candidateとする。公開契約は既存のFeedback Gateway `2.0.0-alpha.2`を変更せず、Backlog ConnectorはFeedback Service runtime OCIへserver-side componentとして同梱する。Backlog DTO、credential、provider内部IDをbrowser packageまたは公開契約へ追加しない。

## 固定する能力境界

| 操作 | release candidate保証 |
|---|---|
| create | `recoverable` |
| reply | `recoverable` |
| append-only revision | `recoverable` |
| attachment read | `unsupported` |
| attachment upload | `unsupported` |

一時attachment IDと最終issue attachment IDが一致しない制約を、DB、queue、永続cache、object storageで補完しない。Backlog検索の0件は不存在証明にせず、commit後に自動再書込みしない。

## release candidate Gate

- rootと全workspaceのversionおよび内部依存を`1.0.0-rc.1`へ揃える。
- Backlogを含むFeedback Service runtimeの`linux/amd64`／`linux/arm64` OCIを生成する。
- OCI digest、CycloneDX SBOM、HIGH／CRITICAL脆弱性report、checksumをrelease manifestへ記録する。
- builderがsource treeのclean／dirtyをmanifestへ記録し、publisherは`clean`以外をfail-closedで拒否する。
- Jira Cloud／Backlog live evidenceを実装digestへ束縛し、Backlog live Conformanceをrelease候補sourceで再実行する。2026-09-03T08:56:16.907Zの実行で`sha256:da80d6faf07180c200ba3019bf3bb9c030063d6ac3d09f86f0f089d7b2bf75c9`へ一致し、全run-owned issueを削除した。
- `bash scripts/verify-feedback.sh`をskipなしで完走する。

実公開、tag、push、deploymentはこのrelease candidate作成には含めない。

ローカルで未コミット変更から生成した候補は内容確認専用であり、公開対象にしない。公開workflowはcleanなtag checkoutから再生成する。

2026-09-04にskip環境変数なしで正規検証を再実行し、`@geibee/redmine-demo`のruntime config、bootstrap、初期化取消、page破棄cleanupのcharacterization test 2件を含めて`[feedback-verify] PASS`（終了コード0）を確認した。
