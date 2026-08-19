# Feedback Redmine Chrome / Edge拡張機能

Manifest V3の同一artifactをChromeとEdgeへunpacked loadできます。`npm run build`は`dist/unpacked`と、timestampを固定した
`dist/feedback-redmine-extension.zip`を生成します。store署名・uploadは対象外です。
同時に生成する`dist/conformance.js`は実Redmine matrixでmessage handlerを直接検証するprivate test entryであり、ZIPへ含めません。

profileは`chrome.storage.managed`またはoptionsから`chrome.storage.local`へ保存し、API keyはunlock後の
`chrome.storage.session`だけへ保存します。業務画面とRedmineのHTTPS origin permissionは利用者操作で個別に許可します。
content scriptはprofileやcredential storageを直接読みません。

managed policyはmanifestの`managed-policy-schema.json`へ接続され、`managed-policy.example.json`の`profiles` JSON文字列を
例として利用できます。policyにはAPI keyを含めません。local/session/managed storageはいずれもextension trusted contextだけに
制限します。詳しい配布・lock・permission手順は`docs/redmine-extension.md`を参照してください。
