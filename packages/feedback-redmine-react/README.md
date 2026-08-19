# @feedback/redmine-react

`RedmineFeedbackPort`と端末内`ClientStatePort`を中心に構成する共通React UIです。初回投稿だけをwrite可能にし、
Redmine description、全journal、field activity、attachmentはread-onlyで表示します。

DOM captureは`@feedback/dom-capture`を使用し、legacyの`@feedback/react`には依存しません。
本文やattachment bytesを永続storageへ保存しません。
