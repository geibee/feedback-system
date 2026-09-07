# ADR 0005: DBレスの暗号化thread参照とbest-effort重複排除

- 状態: 採用
- 決定日: 2026-09-07

## 文脈

Backlog live再検証では、同じthreadIdの2件を観測した直後の別検索で1件しか見えなかった。検索で1件見えることはprovider全体の一意性の証明ではない。利用者はDBレス維持と重複排除best-effortを選択し、共通参照契約の設計・client導入を指示した。

## 決定

[共通規約](../../contracts/feedback/thread-reference.md)を採用する。正本の保存場所、認可mode、署名Envelope、attachment権限は維持する。

1. stable threadIdとprovider ticket参照を分離する。参照取得後は固定したticketを直接再取得し、毎回検索して別ticketを選ぶことを避ける。
2. browserへ渡すのはscope・audienceに束縛した認証付き暗号化tokenだけ。生の内部ID、署名だけの可読payload、provider URLを渡さない。token自体は認可根拠にならない。
3. DTO追加はopt-in応答に限定する。旧v2 clientのstrict schemaとRedmine v1を維持する。署名・認可・scope・projection検証を弱めない。
4. 独立鍵、30日寿命、鍵ring rotation、fail-closed、検索fallback禁止を固定する。DB／queue／shared cacheは追加しない。
5. createの初回応答喪失と一覧探索は検索依存が残る。best-effortをrecoverable操作のexactly-once保証へ一般化しない。

ADR 0004の「opaque string参照を却下」は、単なる難読化や署名だけの内部ID公開には引き続き適用する。本ADRの認証付き暗号化と毎回の再認可を備えた参照だけを例外とする。

## 帰結

Jira／Redmine／Backlogの差はConnector内の直接取得へ閉じる。serviceがtokenを管理し、HTTP client／controller／rendererはprovider非依存を維持する。新providerは任意portを実装するまで従来検索を継続できる。

鍵を設定しない既存配備では参照拡張を有効化しない。production有効化前に独立secretを配備し、live再検証する。保存済み旧live証跡は本変更の成功証跡へ転用しない。

暗号APIの根拠: [Node.js Crypto（GCM、AAD、認証tag、nonce）](https://nodejs.org/api/crypto.html#cryptocreatecipherivalgorithm-key-iv-options)。
