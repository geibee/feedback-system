# ADR 0002: signed grantのJWT契約

- 状態: 採用
- 決定日: 2026-08-31
- 適用範囲: Authorization Modeが`signed-grant`のFeedback Service v2とv1 facade

## 文脈

Feedback Serviceは認可DB、refresh token、revocation listを保持しない。そのためJWTの対象、operation、resource、寿命を厳密に限定し、別profileや別serviceへ流用できない契約が必要である。

## 決定

JWT compact serializationの最大長は16 KiBとする。JWSの`alg`はissuer設定で一つに固定し、`RS256`、`ES256`、`EdDSA`のいずれかだけを許す。`none`、HMAC系、token headerの`jku`／`x5u`が指定する鍵は許可しない。JWKS取得先はallowlist済みissuer metadataまたはread-only設定だけから解決する。

### issuerとaudience

- issuerはread-only設定の完全一致allowlistに登録する。URLの末尾slash、大小文字、別名を正規化して一致扱いにしない。
- serviceは不変な`serviceId`を持ち、要求audienceを`urn:geibee:feedback-service:<serviceId>`とする。`serviceId`は`^[a-z0-9][a-z0-9._-]{0,99}$`を満たす。
- `aud`は上記値と完全一致する単一stringだけを受け付ける。array、複数audience、部分一致を拒否する。

### 必須claim

共通して次のclaimを必須とする。unknown claimは認可へ使用しない。

| claim | 型と上限 | 検証規約 |
| --- | --- | --- |
| `iss` | URI string、最大200文字 | issuer allowlistと完全一致 |
| `sub` | string、1〜200文字 | 空白だけを拒否し、logへ生値を出さない |
| `aud` | string | service専用audienceと完全一致 |
| `iat` | NumericDate integer | 現在時刻より30秒超未来を拒否 |
| `exp` | NumericDate integer | `exp > iat`かつ`exp - iat <= 300` |
| `scope` | space区切りstring、最大512文字 | 重複、unknown語彙、空tokenを拒否 |
| `feedback_grant_kind` | `oidc`または`token-exchange` | issuer登録種別と完全一致 |
| `feedback_profile_id` | string、最大100文字 | requestのprofile IDと完全一致 |
| `feedback_workspace_id` | string、1〜200文字 | requestおよびprofile固定workspaceと完全一致 |
| `feedback_resource` | 下記object | request対象とfield単位で完全一致 |

`feedback_resource`はunknown propertyを拒否し、次のshapeとする。

```json
{
  "kind": "workspace | record | page",
  "key": "1〜500文字"
}
```

`kind=workspace`の`key`は`feedback_workspace_id`と同値でなければならない。一覧、詳細、writeのrequestが要求するresourceとgrantを完全一致で照合し、親scope、prefix、wildcard、空resourceから権限を推論しない。

直接OIDC grantでは`azp`を必須とし、1〜200文字の値をissuer設定のclient IDと完全一致させる。token exchange JWTでは`client_id`と`act`を必須とし、`client_id`はissuer設定の交換client、`act`はunknown propertyを拒否する`{ "sub": string }`としてissuer設定のactor IDと完全一致させる。token exchangeで`act`を省略したtokenや、直接OIDCでexchange用issuerを使用したtokenは拒否する。

`nbf`が存在する場合はNumericDate integerとして検証し、現在時刻に30秒のclock skewを加えても未到来なら拒否する。`jti`は任意だが、Feedback Serviceは保存せず、exactly-onceや個別失効の根拠にしない。

### scope

許可する語彙は次の6個だけとする。

- `feedback:read`
- `feedback:create`
- `feedback:reply`
- `feedback:revise`
- `feedback:attachment:read`
- `feedback:attachment:upload`

endpointは対応する語彙を明示的に要求する。attachment uploadは常に`feedback:attachment:upload`を要求し、create、reply、readから継承しない。scope検証後も、ADR 0001のprofile policyとbackend capabilityとの積集合を適用する。

### 寿命、失効、再発行

- token最大寿命は発行時刻から300秒である。
- clock skewは過去・未来とも30秒だけ許容する。`exp + 30秒`以降は必ず拒否する。
- Feedback Serviceはrefresh token、認可session、revocation listを保持せず、grantを再発行しない。browserまたは契約済みtoken exchange主体が新しいgrantを取得する。
- 漏洩や権限剥奪から拒否が確実になる上限は、発行直後のtokenについて330秒である。330秒より短い即時失効が必要なprofileは`signed-grant`を使わず`remote-authorization`を選ぶ。

### JWKSとfailure

- JWKS／issuer metadata cacheはprocess内だけに置き、最大32 issuer、issuerごとに最大32 key、TTL最大300秒とする。上流`Cache-Control`が短ければ短い方を使う。
- unknown `kid`では同一issuerにつき一回だけsingle-flightで強制refreshし、それでも見つからなければ拒否する。別issuer、古いkey、modeへfallbackしない。
- TTL切れkeyをJWKS取得障害時にstale利用しない。metadata/JWKSのtimeout、TLS、parse、issuer mismatch、鍵用途／algorithm mismatchはfail-closedとする。
- token、signature、provider credential、JWKS response本文をproblemや通常logへ出さない。観測にはissuerの設定上の識別子、failure分類、trace IDだけを使う。

## 却下した選択肢

- 汎用`openid`やhost固有roleだけでFeedback操作を許可する: request対象へ束縛できないため採用しない。
- 複数audience tokenを許可する: 別service向けtokenの流用余地が増えるため採用しない。
- 長寿命tokenとserver-side revocation list: DBレス条件を壊すため採用しない。
- JWKS障害時のstale key利用: 設定変更や鍵撤去後の失効上限を破るため採用しない。

## 帰結

issuerごとにgrant kind、algorithm、client／actor、JWKS取得先を起動時検証できるread-only設定がPhase 1で必要になる。これはsecretではないが、runtime browser configへは公開しない。
