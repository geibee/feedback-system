# Hard Gate 0 実行記録

判定日: 2026-08-31

対象commit: `cc78a3f18c7a3fa5f6054f7f562de20bc11da156`上の未commit Phase 0変更

## 判定

**Hard Gate 0: PASS**

Phase 0の範囲だけを実装した。汎用v2 OpenAPI／DTO、package skeleton、Connector、Feedback Service本体などPhase 1以降の実装は開始していない。

| 完了条件 | 判定 | 根拠 |
| --- | --- | --- |
| ADRに実装開始を妨げる未決事項がない | PASS | ADR 0001〜0004を採用状態にし、`scripts/check-feedback-phase0.sh`が未決表現と必須決定を検査した |
| v1と主要UI挙動がtestまたは未検証台帳へ記録されている | PASS | gateway 7件、React 4件、plugin 6件のcharacterization testと`compatibility-ledger.md`の明示的未検証台帳 |
| Jira初期対象がCloudに固定されている | PASS | ADR 0001と`jira-cloud-constraints.md`でREST API v3のCloudに限定し、Data Centerを初期対象外にした |
| Feedback Serviceが専用DB等を必要としないtopologyが固定されている | PASS | ADR 0001でDB、queue、persistent／shared application data cache、upload directory、private object storage、host DB直接参照を禁止した |
| Authorization Modeの信頼境界とfail-closed規約が固定されている | PASS | ADR 0001で3 mode、積集合、fallback禁止、remote failureを固定し、ADR 0002でsigned grantの対象、scope、300秒寿命、330秒失効上限、JWKS failureを固定した |
| 正規verify結果が記録されている | PASS | 下記の変更前baselineと変更後verifyがともにskip変数なしで完走した |

## 変更前baseline

- 実行時刻: 2026-08-31T15:53:17+09:00
- 対象: `cc78a3f18c7a3fa5f6054f7f562de20bc11da156`
- command: `env -u FEEDBACK_VERIFY_SKIP_NPM_CI -u FEEDBACK_VERIFY_SKIP_COMMON_CONTRACTS bash scripts/verify-feedback.sh`
- 結果: `[feedback-redmine-verify] PASS`、`[feedback-verify] PASS`
- 既存失敗: なし

## Phase 0 scoped検証

| command／対象 | 結果 |
| --- | --- |
| `bash scripts/check-feedback-phase0.sh` | PASS。ADR、計画書の初期保証、Envelope HMAC固定値、Jira Cloud 8 JSONのparse／構造を検査 |
| `@geibee/feedback-redmine-core` test | 3 files、50 tests PASS |
| `@geibee/feedback-redmine-gateway` test | 5 files、43 tests PASS |
| `@geibee/feedback-redmine-react` test | 4 files、24 tests PASS |
| `@geibee/feedback-redmine-plugin` test | 4 files、44 tests PASS |
| gateway／React／plugin typecheck | すべてPASS |
| `bash -n`、Jira JSON parse、`git diff --check` | すべてPASS |

characterization testにskip、todo、失敗はない。

## 変更後の正規検証

- 実行終了: 2026-08-31T16:22:22+09:00
- command: `env -u FEEDBACK_VERIFY_SKIP_NPM_CI -u FEEDBACK_VERIFY_SKIP_COMMON_CONTRACTS bash scripts/verify-feedback.sh`
- skip環境変数: `FEEDBACK_VERIFY_SKIP_NPM_CI`、`FEEDBACK_VERIFY_SKIP_COMMON_CONTRACTS`ともに未設定
- 結果: `[feedback-phase0] PASS`、`[feedback-redmine-verify] PASS`、`[feedback-verify] PASS`

clean `npm ci`、全workspace typecheck／test／build、契約drift／Spectral、React 18／19 consumer、Chrome smoke、container security、Redmine 5.1.12／6.0.10／6.1.3／7.0.0の実REST conformance、release／publish／multi-architecture container gateが成功した。今回変更による失敗と既存失敗はいずれもない。

既存の`@geibee/redmine-demo` test scriptは`--passWithNoTests`でtest file 0件のまま終了しており、これをPhase 0 test成功件数には含めていない。demo buildと別packageのChrome smokeは成功した。npm dependencyのdeprecated警告とRedmine 6.1のRuby `ostruct`警告は出力されたが、検査失敗はなかった。

## 後続へ送る事項

自動化していない項目は[`compatibility-ledger.md`](./compatibility-ledger.md)へ明示し、成功扱いにしていない。特にJira Cloud create／reply／revisionの`recoverable`分類は管理tenantのfault injectionまで公開せず、attachment uploadは`best-effort`、結果不明時の自動再upload禁止とする。
