# ADR 0003: Envelope canonicalization、key ring、participant ID鍵分離

- 状態: 採用
- 決定日: 2026-08-31
- 適用範囲: v2 Feedback Envelope、message marker、participant credential

## 文脈

ticket管理システム上の検索fieldやpropertyは書換え可能であり、別ticket、別profile、別installationへコピーされる可能性がある。完全な意味情報を署名し、検索projectionと正本を分ける必要がある。また、participant credential署名鍵からparticipant IDを導出すると、通常の鍵rotationで既存投稿の所有者IDが変わる。

## 決定

### 最初のprovider writeと完全Envelope

thread作成の最初のprovider writeは、providerが同じ操作で永続化できる本文／property／markerへ`threadId`、`intentId`、`requestHash`を同時保存する。provider object identityが作成後にだけ得られる場合、Connectorはそのidentityを得た後に完全な署名済みEnvelopeとprojectionを補う。最初のwriteの結果が不明な場合は回復tripletを検索し、完全Envelope不足だけを補修して新しいticketを作らない。

完全Envelopeの`providerBinding`は少なくとも`profileId`、provider installationのstable ID、Connectorが不変と定義したprovider object identityを持ち、すべて署名対象に含める。browser DTOへ`providerBinding`、provider object ID、provider URLをserializeしない。

### canonicalizationと署名入力

- canonical JSONはRFC 8785 JSON Canonicalization Schemeに固定する。
- `signature` propertyを除いたEnvelope payloadをRFC 8785でcanonicalizeし、UTF-8 encodeする。非有限number、duplicate key、lone surrogateなどRFC 8785で安全に表現できない入力を拒否する。
- Envelope署名入力は`UTF8("feedback-envelope\n2\n") || canonicalPayload`とする。
- message marker署名入力は`UTF8("feedback-message-marker\n2\n") || canonicalPayload`とし、親threadの完全な`providerBinding`をpayloadへ含める。
- participant credential署名入力は`UTF8("feedback-participant-credential\n2\n") || canonicalPayload`とする。
- domain separator、schema version、改行byteを上記から変更しない。Envelope、message marker、participant credential間で署名値を流用できないようにする。
- 永続形式の署名は`{ "alg": "HS256", "kid": string, "value": base64url }`とし、base64urlはpaddingなしとする。`signature`自体は署名対象から除くが、`alg`と`kid`に対応しない検証を許可しない。

### key ring

次の3種類を別secret material、別設定、別domainで管理する。

1. Envelope／message marker用HMAC-SHA-256 key ring
2. participant credential用HMAC-SHA-256 key ring
3. participant ID導出用HMAC-SHA-256 key

各keyは32 bytes以上のランダム値とする。key ringは起動時に、ちょうど一つのactive signing keyと0個以上のverify-only keyを持つ。`kid`は設定で明示し、`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`、ring内一意とする。key materialから`kid`を暗黙導出せず、secretに開発用を含む既定値を設けない。

- 新規Envelope／marker／credentialはactive keyだけで署名する。
- providerに永続化したEnvelope／markerの旧鍵は、対象recordの再署名移行が完了して検証対象が0件になったことを確認するまでverify-onlyとして保持する。期間だけを理由に削除しない。
- v2 participant credentialの最大寿命は30日、clock skewは30秒とし、旧credential鍵を最後の発行から30日+30秒以上verify-onlyで保持する。
- key ring取得不能、active key 0個／複数、重複`kid`、短いkeyはreadiness失敗とする。

### participant ID

participant IDはcredential署名key ringとは別の導出keyで、`HMAC-SHA-256(key, "feedback-participant-id\n2\n" || profileId || "\n" || origin || "\n" || browserProfileId)`から決定的に導出する。UUIDへ表現する際はdigestからRFC 4122 variantとversion 5 bitを設定するが、これはUUID namespace SHA-1を意味しない。

participant ID導出keyは通常rotationしない。変更はidentity migrationとして扱い、旧ID alias、既存投稿の自己編集、移行完了条件を先に実装してから行う。credential署名keyのrotationだけではparticipant IDを変更しない。

### 検証とfallback

- unknown `kid`、algorithm mismatch、署名不正、canonicalization不能、schema不正はintegrity errorとし、v2 metadataとして使用しない。
- 署名が正しくても、実際のprofile、installation、provider object identityと`providerBinding`が一致しなければintegrity errorとする。
- v2 Envelopeまたはmarkerが存在するのに検証失敗した場合、legacy custom field／markerへ黙ってfallbackしない。v2 metadataが存在しないlegacy ticketだけをlegacy readerへ渡す。
- 同じ`threadId`または`intentId`のvalid Envelopeが複数objectに存在すれば`repair_required`とし、自動で一つを選ばない。
- key取得障害とunknown `kid`は内部の別failure分類にするが、browser problemへkey情報を出さない。
- 検索projectionは候補抽出だけに使用し、上記検証と現在のAuthorization Mode、profile policy、backend capability、request scopeを通過したobjectだけを返す。

## test vector

Phase 0の固定fixtureを[`docs/phase0/envelope-test-vectors.json`](../phase0/envelope-test-vectors.json)とする。このfixtureは次を含む。

- non-ASCII、property順、numberを含むpayloadとcanonical UTF-8 bytes
- 3種類のdomain separatorごとの署名値
- `signature`除外規約
- provider binding、profile、installation、object identityの各改ざん
- unknown `kid`、verify-only旧鍵、別用途key、別object replay

fixtureのkey materialはtest専用であり、配備設定へ使用してはならない。Phase 2のcodecはこの固定値を変更せずにtestへ取り込み、negative caseを実行可能なtestへする。Phase 0では公開schemaやcodecを追加せず、Phase 1の公開契約draftより前に本番実装を先行させない。

## 帰結

### 2026-09-06 初期本文の完全性補足

Envelopeの任意field `initialBodyHash`を署名対象へ追加する。正常な新規作成は既知の入力本文からhashを計算し、読取り時にprovider本文と照合する。Redmine本文は現行v1 readerと同じ正規化を使用する。旧Envelopeと初回write応答喪失後の本文なし回収では、このfieldを後からprovider本文だけで生成しない。表示とstable ID回収は維持するが、未検証の初期本文はprovider由来として扱い、本人の自己編集権限を付与しない。既存の署名済みrevisionは署名・所有者・body hash・chainを検証して復元できる。旧DB保存版との互換ではなく、Redmine v1 ticket形式の互換だけを維持する。

最初のwriteで回復tripletを保存できても、完全Envelopeの補修が必要なproviderは存在する。補修途中の状態を新規作成成功と混同せず、`pending`または`repair_required`として扱う。HMAC keyを共有する複数instanceでは同じserver-side secret ringを配布する必要があるが、Feedback Service内にkey DBは追加しない。
