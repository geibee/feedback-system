# Jira Cloud Phase 2 contract spike

確認日: 2026-08-31

対象: 管理されたJira Cloud開発site、Jira REST API v3、Forge CLI 13.5.0。site URL、cloud ID、project ID、account情報、credentialはfixtureから除去した。

## Forge構成

`tests/fixtures/jira-cloud-phase2/forge-app/manifest.yml`をdevelopmentへdeployし、Jiraへinstallした。moduleは`jira:entityProperty`一つだけで、`com.geibee.feedback.recovery.v2`の`threadId`、`intentId`、`requestHash`をstring index化する。function、UI、Forge storage、Connect module、scope追加はない。appはPhase 2後もinstallしたまま保持する。

## 実測結果

| 項目 | 結果 |
| --- | --- |
| create issue | top-level `properties`を含む単一POSTでtripletを保存できた |
| issue property read | direct GETでtripletを同値取得できた |
| exact JQL | thread／intentとも完全一致1件。初回thread検索は1秒以内、1回目で取得した |
| provider binding | issue ID取得後に署名Envelopeへ更新し、provider再読込後の署名検証に成功した |
| client timeout | 800msでresponse 0 byte、curl 28。writeを再発行せず最初の検索でissueを回収し、tripletが一致した |
| short timeout miss | 200ms timeoutでは20回の検索後も0件。安全な不存在とはせず`pending`、自動再作成なしとする |
| multiple hit | 同じthread／intentの2 issueを検出し、`repair_required`へ正規化した |
| reply | comment本文と署名message propertyを同じPOSTで保存し、thread内scanでintent 1件を回収した |
| revision | 元commentをPUTせずappend-only commentとして保存し、署名markerを回収した |
| pagination | 2 commentsを`maxResults=1`で1件ずつ取得した |
| attachment upload | multipart field `file`と`X-Atlassian-Token: no-check`で104 bytesを一回だけuploadした |
| attachment mapping | 成功response後に署名stable/provider ID mappingをissue propertyへ保存・再検証した |
| attachment download | metadataのcontent URLを`Accept: */*`で取得しhash一致。`Accept: application/octet-stream`では406だった |
| creation fields | non-subtask taskでsummary、issue type、project、reporterがrequiredとして返った |

Jira property検索は候補抽出に限る。JQL hitだけで正本・認可済みと判断せず、direct property GET、署名、provider object binding、scope、現在の認可を検証する。index反映前のmissは`pending`とし、同じcreateを再POSTしない。

## 保証水準

- create: `recoverable`
- reply: `recoverable`
- revision: `best-effort`。expected revision確認とcomment appendのatomic conditionがないため。
- attachment upload: `best-effort`。native APIはresponse喪失後にstable attachment IDで一意検索できないため。

## 反例と縮退

- comment propertyはissue entity propertyのようなglobal JQL indexにせず、まずthread IDでissueを一意解決してcommentsをpage走査する。
- propertyは32,768 bytes上限を前提に、小さなEnvelope／markerだけを置く。本文やbinaryをpropertyへ複製しない。
- permission不足は403 `feedback.forbidden`、attachment disabled／media不整合はcapabilityまたは415、rate limitは429、provider timeoutは504へ正規化する。
- test userのpermissionはBrowse、Create Issue、Edit Issue、Comment、Attachment、Deleteを事前確認した。permissionを変更するnegative live testは行わず、fixtureとfakeでfail-closedを検査する。

参考:

- [Jira entity property module](https://developer.atlassian.com/platform/forge/manifest-reference/modules/jira-entity-property/)
- [Jira Cloud REST v3 Issues](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/)
- [Issue properties](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-properties/)
- [Comments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/)
- [Attachments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-attachments/)
