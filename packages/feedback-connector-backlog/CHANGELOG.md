# 変更履歴

## 未リリース - 2026-09-06

- 既知の初期本文の署名hashを検証し、旧Envelope／応答喪失回収時の未検証本文を本人へ帰属させない。署名済みrevisionの互換性は保持する。

## 1.0.0-rc.1 - 2026-09-02

- Backlog SaaS Stage A Hard GateとStage B live Conformanceを通過した初回release candidateとした。
- create、reply、append-only revisionを`recoverable`としてproviderだけから回収し、attachment read／uploadを`unsupported`として固定した。
- 4 Text custom fieldによるthread／resource projection、別process再構築、複数候補の`repair_required`、自動再書込み禁止をrelease Gateへ束縛した。

## 1.0.0-alpha.7

- Backlog SaaS Stage A Hard Gateに基づくDBレスConnectorを追加した。
- create、reply、append-only revisionをrecoverable、attachmentをunsupportedとした。
- Stage B live Conformanceを通過し、issue DTOのcustom field種別を実wireの`fieldTypeId`へ修正した。
