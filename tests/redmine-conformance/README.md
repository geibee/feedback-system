# Redmine実REST conformance

Docker Official Imageをdigestで固定し、throw-away SQLite containerでissue作成、journal、attachment、
Redmineだけからのthread再構築を確認する。作成、一覧、詳細、attachment取得はすべて業務アプリケーションと
同一originのgateway handlerを経由する。issue本文のSPA URLがlinkになり、添付した証跡画像がclick可能なthumbnailとして
表示されることをCommonMarkとTextileの両形式で確認する。
既存のRedmineやvolumeには接続しない。

```bash
bash tests/redmine-conformance/run-local-matrix.sh
```

matrixは公式のexact tag `5.1.12-bookworm`、`6.0.10-bookworm`、`6.1.3-bookworm`、
`7.0.0-bookworm`を使用する。すべてmulti-platform manifest digestへ固定し、container内の実versionも照合する。
特定versionだけを再検証する場合は次を実行する。

```bash
bash tests/redmine-conformance/run-local-matrix.sh --only=5.1.12
```

repository final gateは4版すべてをserial検証し、tag/digest欠落をskipせずfail-closedする。

image更新時は`images.lock.json`のtagとmulti-platform manifest digestを同じreview changeで更新する。
