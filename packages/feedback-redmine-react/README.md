# @feedback/redmine-react

`RedmineFeedbackPort`と端末内`ClientStatePort`だけに依存する共通React UIです。初回投稿だけをwrite可能にし、
Redmine description、全journal、field activity、attachmentはread-onlyで表示します。

pluginとChrome / Edge拡張が同じcomponentを利用します。本文やattachment bytesを永続storageへ保存しません。
