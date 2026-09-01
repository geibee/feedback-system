# 署名鍵rotation

## Envelope／participant credential key ring

1. 旧active鍵を残したまま、新しい32 bytes以上の鍵と一意な`kid`をringへ追加する。
2. `activeKid`を新鍵へ変更する。runtimeは新規artifactを新鍵で署名し、ring内の旧鍵をverify-onlyとして検証する。
3. `/readyz`と旧鍵fault fixtureを通し、旧ticketと既存participant credentialを読めることを確認する。
4. 旧鍵で署名されたprovider artifactまたは未失効credentialが残る間は旧鍵を削除しない。
5. retention判断後に別releaseで旧鍵を削除する。削除後のunknown `kid`はfallbackせず署名失敗にする。

Envelope ringとparticipant credential ringは別secretで回す。片方の鍵を他用途へ流用しない。

## participant ID derivation key

通常rotationしない。この鍵を変えるとsigned／remote subjectとpublic browser profileから導出するparticipant IDが変わり、自己編集ownershipが継続しない。漏えい時はincidentとして対象profile writeを停止し、影響範囲、ownership継続可否、新profile／installationへの切替を判断する。旧鍵と新鍵の暗黙fallbackやproviderへの生subject保存は行わない。
