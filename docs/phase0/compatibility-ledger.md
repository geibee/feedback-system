# Phase 0 互換台帳

記録日: 2026-08-31

この台帳は汎用v2の実装前に維持するRedmine v1、browser state、公開package境界を記録する。契約の正本は引き続き`contracts/feedback`であり、この文書へAPI／DTO定義を複製しない。Phase 0ではAPI、DTO、runtime設定項目を変更していない。

## package export

すべて現在のversionは`1.0.0-alpha.7`である。`package.json`の`exports`と対応する`src/index.ts`または専用entry pointを正本とし、Phase 0〜2ではentry pointや公開symbolを削除、renameしない。

| package | export subpath | 実体／用途 |
| --- | --- | --- |
| `@geibee/feedback-contracts` | `.` | `dist/index.js`、`dist/index.d.ts` |
|  | `./redmine-gateway.openapi.yaml` | v1 OpenAPI |
|  | `./schemas/*` | 公開JSON Schema |
| `@geibee/feedback-core` | `.` | provider非依存target、evidence、host型 |
| `@geibee/feedback-dom-capture` | `.` | DOM evidence provider |
| `@geibee/feedback-maplibre` | `.` | MapLibre capture、target、pin adapter |
| `@geibee/feedback-react-ui` | `.` | DOM target解決と公開attribute定数 |
| `@geibee/feedback-redmine-core` | `.` | v1 client model、port、normalization、browser state契約 |
|  | `./trusted` | server内部のRedmine client／marker処理 |
| `@geibee/feedback-redmine-gateway` | `.` | gateway handler、problem、server profile型 |
| `@geibee/feedback-redmine-ops` | `.` | inspect／doctor／provision処理 |
|  | `./assets/*` | 配備asset |
|  | bin `feedback-redmine` | 運用CLI |
| `@geibee/feedback-redmine-plugin` | `.` | transport、mount、browser state、validation、runtime config |
|  | `./loader` | SPA controller、遅延load、runtime config loader |
| `@geibee/feedback-redmine-react` | `.` | Overlay、Provider、Thread UI、capture、style、error mapping |
|  | `./styles.css` | `dist/styles.css` |

`apps/**`と`tests/**`は公開package exportを持たない。汎用packageはADR 0004で予約した名称をPhase 1の単一integration作業で追加し、既存exportをその場で汎用型へ置換しない。

## browser storage key

`origin`、`profileId`、`principalScopeHash`で利用範囲を分離する。browser storageは端末内UX stateであり、Feedback本文、認可decision、provider responseの正本ではない。storage拒否時は当該page lifecycle内のmemory stateへ退避し、端末間同期を提供しない。

| storage | key | 内容／lifecycle |
| --- | --- | --- |
| localStorage | `feedback.redmine.v1:${origin}:${profileId}:${principalScopeHash}:follow-index` | follow済み`threadId`の索引。最大10,000件を検証する |
| localStorage | `feedback.redmine.v1:${origin}:${profileId}:${principalScopeHash}:follow:${threadId}` | follow、既読journal、最終issue更新時刻 |
| localStorage | `feedback.redmine.v1:${origin}:${profileId}:${principalScopeHash}:intent` | prepared／uncertain pending intent。7日後に期限切れとして削除する |
| sessionStorage | `feedback.redmine.v1:${origin}:${profileId}:${principalScopeHash}:draft` | page session内draft。読込時20,000文字上限 |
| localStorage | `feedback.redmine.participant.v1:${origin}:${profileId}` | 公開participant IDと署名credential |
| localStorage | `feedback.redmine.participant-name.v1:${profileId}` | 利用者が入力した表示名。最大100文字 |

`purgeBrowserClientState`は指定したorigin／profileのv1 state、participant、表示名だけを削除し、他profileやhost keyを削除しない。v2のdraft、follow、unread、pending intentも初期保証では端末内状態とし、このv1 keyを無断で再利用しない。

## runtime config

| 項目 | 固定値／規約 |
| --- | --- |
| 既定path | `/.well-known/feedback-redmine.json` |
| HTTP | `GET`、`credentials: same-origin`、`cache: no-store`、`Accept: application/json` |
| response | 2xxかつmedia typeが`application/json`の場合だけ受理 |
| timeout | 既定5,000 ms、設定可能範囲1〜60,000 msのinteger |
| exact shape | `schemaVersion: "1"`、`enabled: boolean`、`profileId`、`gatewayBasePath`、任意の`submissionNotice` |
| path境界 | config pathとgateway base pathは同一originのroot-relative path。userinfo、fragment、backslash、dot segment等を拒否 |
| failure | fetch、timeout、abort以外の検証失敗、unknown propertyをfail-closedにし、controllerを有効化しない |
| 禁止情報 | credential、署名鍵、Redmine URL、API key、project／tracker／custom field IDを含めない |

既存schemaは`contracts/feedback/schemas/redmine-runtime-config.schema.json`、読込挙動は`packages/feedback-redmine-plugin/src/runtime-config.ts`を正本とする。Phase 0で設定項目やenvironment variableは追加していない。

## characterization coverage

| 領域 | Phase 0で固定した挙動 | 自動test |
| --- | --- | --- |
| v1 profile／public-profile | credentialなしのprofile到達、unknown profile拒否、participant credentialを本人認証へ昇格しない公開投稿境界 | `packages/feedback-redmine-gateway/src/v1-characterization.test.ts` |
| v1 read | credentialなしの一覧、resource所属を確認する詳細、添付metadata／bytes取得 | 同上 |
| v1 write | issue投稿、credential必須の返信、participant marker、別participant編集拒否、所有者の追記型自己編集 | 同上 |
| UI follow／unread | follow済みthreadの未読表示、詳細表示で既読化、follow変更保存 | `packages/feedback-redmine-react/src/phase0-characterization.test.tsx` |
| UI pending intent | retryable結果不明後の同一draft再送で`threadId`／`intentId`を再利用 | 同上 |
| UI capture／navigation | composer cancellation後の遅延capture破棄、navigation後のlocation不一致時のfail-closed | 同上 |
| plugin lifecycle | mount、二重mount拒否、unmount、remount、disable／再enable | `packages/feedback-redmine-plugin/src/phase0-characterization.test.tsx` |
| destroy boundary | gateway、storage fallback、dynamic import、purgeの遅延resolve／rejectからhost callbackや副作用を発生させない | 同上 |

## 明示的な未検証台帳

次はHard Gate 0で成功扱いにせず、後続Phaseのfixture、browser E2E、provider acceptanceへ送る。

| 項目 | 現在固定できている範囲 | 後続の検証 |
| --- | --- | --- |
| live Redmine v1の各characterization scenario | in-process Redmine REST fixtureと正規verifyのversion別conformance | 管理されたlive環境でprofile、read、write、attachmentを再実行 |
| evidence付きv1 createの画像upload | context JSON uploadと既存upload unit test | browserからgateway、Redmine attachmentまでのE2E |
| v1 initial messageのgateway自己編集 | reply自己編集とcoreのcontext ownership復元 | gateway endpoint経由のinitial message edit |
| v1 reply／edit timeout後の回収 | marker保存と通常response | response喪失fault injection。v1へ新保証は追加しない |
| capture marker処理中のcancel | capture provider完了直後のgeneration guard | marker後処理中のstale commit反例 |
| `feedbackThread` query／hash deep link | navigation request後のlocation照合 | 起動時deep-linkのbrowser UI test |
| browser reload後のstate復元 | storage port単体と同一runtime内の再送 | reloadを含むdraft／follow／intent browser E2E |
| runtime configから実mountまで | loader、runtime config、mountを個別test | `enabled: true`のbrowser統合test |
| `messages` DTOの未読算定 | legacy timeline経路 | `messages`経路のunread fixture |
| Jira Cloud create／reply／revision回収 | 公式契約調査と合成反例fixture | `docs/phase0/jira-cloud-constraints.md`記載の管理tenant fault injection |
| Jira Cloud attachment部分成功／重複 | 公開契約上は`best-effort`、結果不明時再upload禁止 | 管理tenantで同名file、複数file、response喪失を確認 |

## Phase 0 baseline

変更前のcommit `cc78a3f18c7a3fa5f6054f7f562de20bc11da156`に対し、2026-08-31T15:53:17+09:00に次を実行した。

```sh
env -u FEEDBACK_VERIFY_SKIP_NPM_CI -u FEEDBACK_VERIFY_SKIP_COMMON_CONTRACTS bash scripts/verify-feedback.sh
```

結果は`[feedback-verify] PASS`である。clean `npm ci`、全workspaceのtypecheck／test／build、OpenAPI drift／Spectral、Chrome smoke、container security、Redmine 5.1.12／6.0.10／6.1.3／7.0.0の実REST conformance、release／publish／multi-architecture container gateがすべて成功した。skip変数は未設定であり、未実行項目や既存失敗はなかった。

Phase 0変更後の正規検証結果は[`hard-gate-0.md`](./hard-gate-0.md)へ記録する。
