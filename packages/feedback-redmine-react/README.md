# @feedback/redmine-react

`RedmineFeedbackPort`と端末内`ClientStatePort`を中心に構成する共通React UIです。旧`@feedback/react`の2つの起動ボタン、
対象選択bar、右クリックmenu、独立composer／Workspace一覧／詳細drawer、pinの外観とresponsive sheetを引き継ぎます。
DOM/画面/MapLibre位置の投稿、自動スクリーンショット添付、返信、自己編集、編集履歴、未読、deep linkを提供します。
Redmine description、全journal、field activity、attachmentを読み直し、Redmine側の返信や更新を15秒以内またはfocus復帰時に反映します。

DOM captureは`@feedback/dom-capture`を既定で接続し、共通target解決は`@feedback/react-ui`を使用します。Host Adapterの
`captureEvidence`は任意の上書きであり、未指定でもキャプチャします。保存画像には選択位置のFeedbackピンを焼き込みます。
legacyの`@feedback/react`には依存しません。
本文やattachment bytesを永続storageへ保存しません。
`src/styles.css`をstyleの正本とし、`npm run styles:sync`がShadow DOM注入用TypeScriptを生成します。
`typecheck`と`build`は生成物のdriftを拒否します。
