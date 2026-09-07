# Jira Cloud Phase 5 evidence

管理されたJira Cloud開発siteで`scripts/run-feedback-jira-live-acceptance.mjs`を実行した結果と、Forge entity property index artifactのdeploy／install確認をtenant情報除去後に保存する。

- site URL、cloud／project／issue／account ID、email、credentialを保存しない。
- live acceptanceが作成したrun-owned issueだけを削除する。
- Forge development installationは保持する。
- fixtureは実行成功時だけ追加し、未実行のplaceholderをPASS証跡にしない。
