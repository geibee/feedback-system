# Phase 5 rollback

## application rollback

1. 新規v2 trafficを停止し、直前のimmutable Feedback Service runtime imageへ戻す。
2. v1 Redmine gatewayを独立して継続する。v2 DB migrationやshared cacheはないためrollback jobは不要である。
3. v2がdual-writeしたRedmine markerは削除しない。v1 readerはlegacy markerを読み、UUIDv7／UUIDv8を維持する。
4. 結果不明intentはprovider metadataを残し、自動再writeしない。

## 設定rollback

provider profile、Connector catalog、key ringを同じrelease bundleの直前versionへ戻す。ただし新鍵で署名済みartifactがある場合、新鍵をverify-onlyとして残さず旧ringだけへ戻してはならない。profileのAuthorization Modeを障害回避目的で変更しない。

## Forge rollback

Forge entity property indexはFeedback Serviceと別artifactである。runtime rollbackだけを理由にuninstallしない。index definitionのrollbackが必要な場合も、既存property値を削除せず、Atlassianのmajor-version upgrade／rollback手順を独立して実施する。

run-owned managed acceptance issueは試験終了時に削除する。既存利用者issue、project、Forge development installationはcleanup対象外である。
