# Backlog Stage A fixture

`provider-facts.json`はBacklog API v2の公式資料から固定した合成fixtureである。`live-gate.json`は管理されたBacklog SaaS無料体験spaceで`scripts/run-feedback-backlog-stage-a.mjs`を実行した匿名化結果である。どちらにも実在space、project、issue、comment、attachment、account、credentialを含めない。

静的fixtureの`observation.liveSpaceObserved=false`と`hardGate.passed=false`は公開資料だけからの判定を示し、live証跡で上書きしない。Hard Gate判定は現source digestへ束縛した`live-gate.json`を使用する。

live結果ではcreate、reply、append-only revisionを`recoverable`へ強化した。一方、Backlogは一時upload IDをissue attachmentの最終IDへ変換するため、既存attachment markerを最終provider IDへ同一writeで束縛できない。attachment read／uploadは`unsupported`とし、DBやBacklog外storageで補完しない。

合成ID `5`、`2`、`3`、`900001`〜`900003`はrequest形状を示すだけであり、provisioning値として使用しない。
