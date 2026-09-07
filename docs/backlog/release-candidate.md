# Backlog Connector release candidate

## 対象

monorepo version `1.0.0-rc.1`を最初のBacklog release candidateとする。現在の公開契約はFeedback Gateway `2.0.0-alpha.3`（共通の暗号化threadReference拡張）であり、Backlog ConnectorはFeedback Service runtime OCIへserver-side componentとして同梱する。Backlog DTO、credential、provider内部IDをbrowser packageまたは公開契約へ追加しない。

## 固定する能力境界

| 操作 | release candidate保証 |
|---|---|
| create | `recoverable` |
| reply | `recoverable` |
| append-only revision | `recoverable` |
| attachment read | `unsupported` |
| attachment upload | `unsupported` |

一時attachment IDと最終issue attachment IDが一致しない制約を、DB、queue、永続cache、object storageで補完しない。Backlog検索の0件は不存在証明にせず、commit後に自動再書込みしない。

検索による重複排除はbest-effortであり、検索結果一件は全体の一意性証明ではない。参照取得後は暗号化threadReferenceにより操作先を固定する。失効・改ざん・scope不一致時に検索へfallbackしない。

## release candidate Gate

- rootと全workspaceのversionおよび内部依存を`1.0.0-rc.1`へ揃える。
- Backlogを含むFeedback Service runtimeの`linux/amd64`／`linux/arm64` OCIを生成する。
- OCI digest、CycloneDX SBOM、HIGH／CRITICAL脆弱性report、checksumをrelease manifestへ記録する。
- builderがsource treeのclean／dirtyをmanifestへ記録し、publisherは`clean`以外をfail-closedで拒否する。
- Jira Cloud／Backlog live evidenceを実装digestへ束縛し、Backlog live Conformanceをrelease候補sourceで再実行する。2026-09-07T05:15:03.535Zの最終実行で`sha256:03f41b8111711c30cdd0e8e9fd6c8767fa55e5d20c0635c8f2d6e648502da486`へ一致し、cleanup対象四件・失敗0・残存0を確認した。
- `bash scripts/verify-feedback.sh`をskipなしで完走する。

実公開、tag、push、deploymentはこのrelease candidate作成には含めない。

ローカルで未コミット変更から生成した候補は内容確認専用であり、公開対象にしない。公開workflowはcleanなtag checkoutから再生成する。

2026-09-04にskip環境変数なしで正規検証を再実行し、`@geibee/redmine-demo`のruntime config、bootstrap、初期化取消、page破棄cleanupのcharacterization test 2件を含めて`[feedback-verify] PASS`（終了コード0）を確認した。

## 2026-09-07の再承認条件

上記2026-09-03／04のPASSはalpha.2当時の記録であり、現候補の承認ではない。alpha.3の公開credential／Service／client／直接参照経路を含むJira・Backlog live Gateと、skipなしの正規verifyを再実行する。旧証跡のversionやdigestだけを変更して承認してはならない。

2026-09-07に上記alpha.3再承認条件をすべて満たした。provider acceptance 21件、Phase 5 Gate、skipなしの正規verifyはPASSした。
