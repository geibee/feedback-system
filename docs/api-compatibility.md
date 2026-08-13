# API互換性

`/feedback/v1` と `@feedback/*` 1.xの公開APIは後方互換を維持する。React以外の公式境界は
`@feedback/core`、OpenAPI、JSON Schema。MapLibreとAdmin UIは任意packageである。

`FeedbackHostAdapter.subscribe`は任意メソッドとして追加し、既存adapterの実装を壊さない。実装したhostでは
route／workspace変更をReact Providerへ通知でき、未実装時は従来どおり初回取得と明示的`refresh`を利用する。
transportのcontext取得メソッドへ追加した`AbortSignal` optionも任意で、既存transport実装はそのまま適合する。
これらはHTTP API／DTO／JSON Schemaを変更しないため、OpenAPIと生成契約型の更新対象ではない。

v1は1つの組織またはtrust domainごとにServiceを配備し、`applicationKey`をService全体で一意とする。
`tenantKey`をHostContextとAPI scopeへ追加する共有マルチテナント化は、URL・DTO・DB一意制約を同時に変更するため
v2の契約変更として扱う。v1 clientへtenant選択を暗黙に追加しない。

application manifestのGET応答へ`ETag`を追加する変更は、既存bodyを変えない後方互換のheader追加である。
宣言的同期clientはGETで得た値を更新PUTの`If-Match`へそのまま渡し、412時に暗黙の再試行や上書きをしない。

registry公開前は `npm pack` のtarballをcleanなReact 18/19 + Vite consumerへinstallして検証する。
公開時は同じpackage versionとService image tagをnpm互換registry/OCI registryへ配置する。
