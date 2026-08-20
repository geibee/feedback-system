# @feedback/redmine-react

`RedmineFeedbackPort`と端末内`ClientStatePort`を中心に構成する共通React UIです。DOM/画面/MapLibre位置の投稿、右クリック、
任意スクリーンショット、返信、自己編集、編集履歴、未読、deep link、responsive drawerを提供します。
Redmine description、全journal、field activity、attachmentを読み直し、Redmine側の返信や更新を15秒以内またはfocus復帰時に反映します。

DOM captureは`@feedback/dom-capture`、共通target解決は`@feedback/react-ui`を使用し、legacyの`@feedback/react`には依存しません。
本文やattachment bytesを永続storageへ保存しません。
