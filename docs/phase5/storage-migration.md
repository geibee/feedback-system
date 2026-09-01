# 保存形式migration

## 方針

一括migration用DBやqueueを追加しない。既存v1 ticketをv2へ必須変換せず、v1 readerはそのまま動作させる。v2が作成するRedmine eventはv1 markerと署名v2 markerを同一provider writeへdual-writeし、Jira Cloudはissue／comment／attachment propertyを正本とする。

既存ticketへv2 metadataを補うのは、そのticketがv2操作の対象になり、`threadId`からprovider objectを一意に解決できた場合だけである。seed-only、Envelope-onlyは同じobjectへ不足artifactだけを補修し、新ticketを作らない。署名不正、scope不一致、複数hitは自動補修せず`integrity_error`または`repair_required`へ閉じる。

## cutover

1. v1 characterizationとRedmine 4 version conformanceを先に通す。
2. v2 readerをread-onlyで有効化し、legacy／valid v2／invalid v2のfixtureを確認する。
3. profile単位でv2 writeを有効化する。v1とv2で同じprovider ticketを正本とし、二重起票を避ける。
4. 結果不明のcreate／replyはprovider検索による回収だけを行う。revisionとattachmentは自動再writeしない。

## alpha.1 attachment markerからalpha.2への移行

alpha.1のattachment markerは`messageId`を署名していないため、alpha.2 readerはこれを有効なv2 mappingとして受理しない。provider上のdescriptionや配置順から関連先を推測して再署名してはならない。

1. alpha.1 v2 writeを停止し、対象ticketとattachmentをread-onlyで列挙する。
2. browserが保持する元message、元binary、content hashを利用者が確認できる場合だけ、新しい`attachmentId`とintentでalpha.2 uploadを一回実行する。
3. 結果不明時は自動再uploadせずmanual confirmationへ移す。
4. 確認できないalpha.1 mappingはprovider native attachmentとして保持し、署名済みv2 attachmentとして返さない。

管理Jira Cloud acceptanceのalpha.1 run-owned issueは削除済みである。production dataが存在しない環境ではmigration writeは不要である。

端末localのdraft／follow／unread／pending intentはbrowser storageに残り、server migration対象ではない。端末間同期は提供しない。
