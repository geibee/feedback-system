# Incident runbook

## 切り分け

1. trace ID、operation、profile ID、HTTP status、provider rate limit／timeoutを確認する。credential、token、本文、attachmentをlogへ出さない。
2. `/healthz`と`/readyz`を分けて確認する。readiness失敗は設定／secret、operationの502／504はproviderまたはnetworkとして扱う。
3. `authorization_unavailable`はmode固定port、JWKS／remote authorization、認証済みsubject adapterを確認し、public-profileへ切り替えない。
4. `integrity_error`はEnvelope署名、provider binding、scope、projection差異を確認し、legacy metadataや検索projectionで返却しない。
5. `repair_required`は同一thread／intentの候補数をprovider上で確認する。自動writeを再開しない。

## provider write結果不明

- create／reply: 同じ`threadId`、`intentId`、`requestHash`でrecover endpointだけを実行する。新しいprovider writeを自動発行しない。
- revision: provider eventが一意に確認できた場合だけcompleted。その他はdo-not-write。
- attachment: binaryを自動再uploadしない。provider attachmentと署名mappingを手動確認する。

## key／認可incident

- unknown `kid`急増: key ring配備順とsecret versionを確認し、旧keyを安全に復元できる場合だけverify-onlyで戻す。
- 署名鍵漏えい: writeを停止し、鍵用途ごとに影響を分離する。participant ID derivation鍵は通常rotationと同じ扱いにしない。
- remote authorization障害: fail-closedを維持する。decision cacheやmode fallbackを新設しない。

provider障害中のoffline read、exactly-once、不変監査を復旧策として約束しない。
