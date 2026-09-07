# リリース準備（2026-09-07）

## 対象と停止条件

既存候補version `1.0.0-rc.1`、共通契約 `2.0.0-alpha.3`を対象とする。DBレス、Redmine v1互換、重複排除best-effort、Backlog attachment unsupportedを維持する。

release候補Gateは通過した。Jira／Backlog live証跡を現sourceへ束縛し、正規verifyはskipなしでPASSした。Jiraのrun-owned orphan二件は後続credentialで各一件を厳密照合して削除し、最終runは作成二件・削除二件・失敗0。Backlogも全runで残存0を確認した。tag、push、npm／OCI publish、本番配備はまだ実施していない。

## 今回の追加作業

- `scripts/lib/feedback-reference-acceptance.mjs`: 公開participant credential発行→HTTP client→実Service→production projection verifier→実Connectorの参照経路を共通化した。投稿、詳細、返信、自己編集、操作回収、Service再構成、改ざん・scope不一致・現在の認可取消しを検査する。Jiraでは添付往復、Backlogでは同じthreadIdの別issueへの操作混入がないことも検査する。
- Jira／Backlogの既存live runnerへ上記試験を追加した。Jiraは複数のrun-owned issueを追跡してcleanupし、失敗時も匿名化したcleanup件数を出す。
- 最初のJira live実行で、fetch adapterがJSONを`text()`で読む場合に2件目の作成IDを追跡しない問題を検出した。`json()`／`text()`の両方で全作成IDを追跡するよう修正した。機能GateはPASS・記録済みcleanup一件は成功したが、参照経路のissue一件が残った可能性がある。`scripts/cleanup-feedback-jira-live-orphan.mjs`は実行時刻±5分、専用summary、本文、recovery propertyのworkspace／resource／tripletをすべて照合し、該当一件以下だけを削除する。
- `scripts/lib/feedback-duplicate-acceptance.mjs`: Backlog回収呼出しが実際に観測した0／1／複数件と判断を照合する。一件を全体の一意性証明とは扱わない。複数件をcompletedにした結果は拒否する。
- `scripts/lib/feedback-live-digest.mjs`: 契約、schema、lockfile、client、Service、Gateway、Envelope、SDK、runtime、対象Connector、live runnerを証跡digestへ束縛する。保存済み証跡と現sourceの照合を共通化した。
- `scripts/build-feedback-live-dependencies.sh`: live runnerの全依存を順にbuildする。Jira wrapperのbuild logはstderrとし、stdoutをJSONだけにした。
- `tests/feedback-provider-acceptance/src/reference-live-runner.test.ts`と`reference-live-fixture.ts`: 外部writeなしの6件を追加した。実Service／client／Backlog Connectorの操作往復と重複先の分離を含む。
- `tests/feedback-provider-acceptance/package.json`／lockfile: 上記testで直接使うBacklog Connector依存を明示した。
- `contracts/feedback/package.json`: `thread-reference.md`を配布物へ含めた。Phase 5のfreeze checksumにも正本文書を追加した。
- Service／runtime／client／controller／Gateway／SDK／3 ConnectorのCHANGELOG、Backlog RC文書、配備・release手順を更新した。readinessがBacklog APIも呼ぶという古い配備文書の記述を、現行のローカル検査へ訂正した。

この準備作業では新しい公開DTOや設定項目を追加していない。前回実装のalpha.3契約とsecret設定をそのまま検証・配布する。

## 検証記録

| 検証 | 結果 |
| --- | --- |
| live依存10 packageのbuild | PASS |
| provider acceptance typecheck | PASS |
| 共通live runner回帰 | PASS、6件 |
| 上記＋Service/client/Jira統合＋renderer scoped test | PASS、16件 |
| provider acceptance全体 | PASS、21件 |
| Service publisherのオフライン検査 | PASS、外部公開なし |
| 契約packageのnpm pack dry-run | PASS、thread-reference.mdを含む |
| 正規verify、skip指定なし | PASS（exit 0）、`[feedback-verify] PASS` |
| Service OCI release候補検査 | PASS、amd64／arm64、SBOM、脆弱性、checksum、manifest。外部公開なし |
| Jira／Backlog新sourceのlive | PASS。Jira最終runはcleanup対象2件・失敗0、Backlog Stage A／Bも残存0 |

### live進捗

- Backlog Stage B（2026-09-07T04:47:32.627Z）: PASS。回収時の観測は一件・completedだが`globalUniquenessProven: false`。固定参照で重複issueへの操作混入なし。run-owned issue 4件、削除失敗0、残存0。証跡fixtureへ反映した。
- Backlog Stage A（2026-09-07T04:52:31.408Z）: PASS。create／reply／revision recoverable、attachment unsupported、別process再構築、run-owned data全削除。証跡fixtureへ反映した。
- Jira初回（2026-09-07T04:47:33.002Z）: 機能項目はPASS、記録済み一件のcleanupもPASS。ただし2件目の追跡不足が判明したため証跡不採用。次のcredentialで専用matcherにより残存一件を照合・削除した。
- Jira再実行（2026-09-07T04:52:42.144Z）: 機能項目はPASSしたが、cleanup集合が再び一件だったため証跡不採用。初回検索解決IDとService内のprovider解決callbackを明示追跡するようrunnerを再修正した。このrunの残存可能性一件をcleanup後、もう一度実行する必要がある。
- Jira最終run（2026-09-07T04:59:44.813Z）: PASS。直前runの残存一件を厳密照合して削除後に実行し、公開credential、Service、client、直接参照、reply／revision／intent回収、添付、改ざん・scope不一致・現在の認可取消しを確認した。作成2件を追跡し、cleanup対象2件・失敗0。証跡fixtureへ反映した。
- Jira cleanup追跡helperをlive digest対象へ追加した後のprovider acceptanceは21件中20件PASS。共通digest実装自身のhashが変わったため、直前に成功したBacklog Stage B証跡だけが失効した。証跡値は手修正せず、Stage Bを同じsourceで再実行する。
- Backlog Stage B最終run（2026-09-07T05:15:03.535Z）: PASS。現digestへ一致し、回収時観測一件を全体一意性とは扱わず、固定参照で重複issueを分離した。cleanup対象4件・失敗0・残存0。最終証跡へ反映した。

初回runner回帰は試験側の2問題（repository構築をprovider通信と誤計数、browser環境のURLとNode file URLの差）で失敗し、修正後に上記件数でPASSした。pack dry-runは初回sandboxのnpm cache書込み制限で失敗し、権限付き再実行でPASSした。既存GitHub release一覧のreadもsandboxの接続制限後、権限付きで成功した。未実行の外部liveをこれらのローカルPASSで代替しない。

最終log directory: `/tmp/feedback-release-final-verify.gGyZlZ`。

- [正規verify log](/tmp/feedback-release-preparation.alpKS9/verify-feedback.log): `npm ci`からskip指定なしで実行。Redmine 5.1.12／6.0.10／6.1.3／7.0.0のDocker conformance、consumer／plugin／security、release／publish／platformを通過し、`[feedback-redmine-verify] PASS`。Phase 5の現contract checksum 16件は全件OK。その後`Jira Cloud Phase 5 live evidenceが不正です`で停止した。正規経路のService publish／release検査は未到達であり、下記scoped実行と区別する。
- [Service OCI検査log](/tmp/feedback-release-preparation.alpKS9/service-release.log): `bash scripts/check-feedback-service-release.sh`を独立して実行しexit 0。
- [provider acceptance全体log](/tmp/feedback-release-preparation.alpKS9/provider-acceptance.log): exit 1、18 PASS／2 FAIL。
- [最終正規verify log](/tmp/feedback-release-final-verify.gGyZlZ/verify-feedback.log): exit 0。Phase 0〜5、Redmine全検証、provider acceptance 21件、Service publisher、amd64／arm64 OCI・SBOM・脆弱性・checksum・manifestを通過し、`[feedback-verify] PASS`。
- [最終provider acceptance log](/tmp/feedback-release-final-verify.gGyZlZ/provider-acceptance.log): typecheckと21件がPASS。
- [最終Phase 5 log](/tmp/feedback-release-final-verify.gGyZlZ/phase5-after-docs.log): 文書更新後も`[feedback-phase5] PASS`。

前回の[共通参照実装報告](thread-reference-implementation-2026-09-07.md)でも正規verifyは同じ旧Jira live証跡で停止していた。今回はさらに参照経路の実測fieldとServiceまでのsource digestを要求するため、旧証跡を流用できない。今回のJira／Backlog liveは未実行であり、成功にも失敗にも数えない。script構文検査、`git diff --check`、stageが空であることの確認もPASSした。

OCI検査は`sourceTreeState: dirty`の内容確認用候補を一時生成したもの。検査scriptの終了時に一時候補をcleanupした。公開用artifactはcleanなtag checkoutから再生成する。保存済みlive証跡の古さを、このpackaging検査のPASSで承認したわけではない。

## 公開前に必要な判断

1. 公開versionを既定の`1.0.0-rc.1`とし、標準GitHub Actionsからnpmjs／GitHub Packages／GHCR／GitHub Releaseへ公開するかを最終確認する。
2. release commitをmainへpushし、cleanなtag checkoutから公開workflowを起動する。dirtyなローカル候補は公開しない。
3. 本番有効化は公開と別工程。対象profileへ独立したthreadReferenceKeyRingを設定し、Serviceを先、clientを後の順に配備する。

以下は今回使用した一回限りFIFOの再現手順。秘密値はchat・repo・通常fileへ書かず、既存FIFOは再利用しない。

```bash
(
  set +x
  : "${FORGE_EMAIL:?Atlassian emailを設定してください}"
  : "${FORGE_API_TOKEN:?Atlassian API tokenを設定してください}"
  : "${BACKLOG_API_KEY:?Backlog API keyを設定してください}"
  umask 077
  release_secret_dir=$(mktemp -d /tmp/feedback-release-secret.XXXXXX)
  mkfifo "$release_secret_dir/jira" "$release_secret_dir/backlog"
  (printf '%s\n%s\n' "$FORGE_EMAIL" "$FORGE_API_TOKEN" > "$release_secret_dir/jira") &
  (printf '%s\n' "$BACKLOG_API_KEY" > "$release_secret_dir/backlog") &
  printf 'JIRA_FIFO=%s\nBACKLOG_FIFO=%s\n' "$release_secret_dir/jira" "$release_secret_dir/backlog"
)
```
