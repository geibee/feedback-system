# API・packageの互換性

この文書は、API、JSON Schema、公開packageを変更する開発者向けのチェックリストです。個々のfieldやresponseはこの文書へ転記せず、次の正本を確認してください。

| 変更対象 | 正本 |
| --- | --- |
| Redmine gateway API | [`contracts/feedback/redmine-gateway.openapi.yaml`](../contracts/feedback/redmine-gateway.openapi.yaml) |
| Redmineのprofile、runtime config、保存形式 | [`contracts/feedback/schemas/redmine-*.json`](../contracts/feedback/schemas) |
| Legacy Feedback Service API | [`contracts/feedback/openapi.yaml`](../contracts/feedback/openapi.yaml) |
| token exchange | [`contracts/feedback/token-exchange.openapi.yaml`](../contracts/feedback/token-exchange.openapi.yaml) |
| releaseごとの差分 | [`contracts/feedback/CHANGELOG.md`](../contracts/feedback/CHANGELOG.md)と各packageの`CHANGELOG.md` |

## 利用者が揃えるversion

Redmine構成では、SPAで使う`@geibee/feedback-*`、`@geibee/feedback-redmine-*`とgatewayを同じversionに揃えます。異なるversionを混在させた配備はサポートしません。

React 18または19とbundlerはSPA側で用意します。公開packageはReactやViteを内包しません。gatewayのbase pathは`/internal/feedback-redmine/v1`で、SPAと同じoriginから公開します。

Legacy構成の`/feedback/v1`を使う場合は、Legacy SDKのmajor versionも`1`に揃えます。新規導入では使用しません。

## 変更時に行うこと

1. 該当するOpenAPIまたはJSON Schemaを先に変更する。
2. `npm --workspace @geibee/feedback-contracts run generate`でTypeScript型を再生成する。
3. gateway、core、利用側packageのcontract testを同じ変更へ追加する。
4. `contracts/feedback/CHANGELOG.md`と変更したpackageの`CHANGELOG.md`へ利用者影響を書く。
5. `bash scripts/verify-feedback.sh`をskip変数なしで実行する。

APIやDTOを変えたのに、正本、生成型、test、CHANGELOGのいずれかが更新されていない変更は完了ではありません。

## versionを上げる判断

| 変更 | 扱い |
| --- | --- |
| 任意fieldや任意endpointの追加 | 同じmajorで追加可能。旧clientの動作をtestする |
| 必須fieldの追加、field削除、型変更、意味変更 | 新しいmajorを用意する |
| runtime configへsecretやRedmineの数値IDを追加 | 実施しない。server profileまたはsecretへ置く |
| gateway path、認証境界、保存形式の非互換変更 | 新しいmajorと移行手順を用意する |
| package内部だけの変更 | 公開型と挙動が変わらないことをcontract testで確認する |

version 1のJSON Schemaはunknown propertyを拒否します。後方互換のつもりでfieldを追加しても、旧gatewayや旧clientが拒否する場合があるため、対応する両方向のtestを追加してください。

## 維持する境界

- browserへRedmine URL、API key、participant署名鍵、project/tracker/custom field IDを渡さない。
- runtime configは`enabled`、`profileId`、同一originのgateway pathと任意の利用者向け案内だけにする。
- thread作成の任意項目はgatewayで有効化したものだけ受け付ける。
- Feedback UIでは投稿、返信、自己編集を扱い、状態、担当者、優先度の変更はRedmineで行う。
- gatewayの`/health/ready`は起動設定だけを確認し、Redmine疎通は`feedback-redmine-ops doctor`で確認する。
- Redmine適合性試験は5.1.12、6.0.10、6.1.3、7.0.0を対象にする。

保存済みデータや公開APIに影響するか判断できない場合は、互換扱いにせず新しいversionとして設計してください。
