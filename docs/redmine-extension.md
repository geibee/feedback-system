# Feedback Redmine Chrome / Edge拡張機能

## artifactと導入

拡張機能はManifest V3の同一artifactをChromeとEdgeへunpacked loadできる。buildはremote codeやsource mapを含まない
`dist/unpacked`と、timestampを固定した再現可能ZIPを生成する。

```bash
npm --workspace @feedback/redmine-extension run build
```

開発時はbrowserの拡張機能管理画面でdeveloper modeを有効にし、`apps/feedback-redmine-extension/dist/unpacked`を読み込む。
store署名・uploadはrepositoryの対象外である。組織配布では生成ZIPを自社の承認・署名手順へ渡す。

## profile

profileはoptionsからlocalへ保存するか、enterprise managed policyの`profiles`へJSON文字列として設定する。
managed profileは同じIDのlocal profileより優先する。正本schemaは
`contracts/feedback/schemas/redmine-extension-profile.schema.json`、Chrome policy schemaは
`apps/feedback-redmine-extension/public/managed-policy-schema.json`、値の例は`managed-policy.example.json`である。

profileには業務画面HTTPS origin、Redmine HTTPS base URL、project/tracker/custom field ID、表示用profileを含める。
API key、cookie、Bearer token、任意HTTP headerは含めない。policy sampleにもsecretはない。
unlock時はcurrent user、project read、固定scope issue readを非破壊で確認する。対象issueが0件なら接続は許可するが、
custom field確認を`not-yet-proven`としてoptions UIへ警告する。

1. optionsでprofile JSONを保存する。
2. 「origin permissionを許可」を利用者操作で実行する。
3. 業務画面originとRedmine originが許可されたことを確認する。
4. 個人Redmine API keyを入力してunlockする。
5. 対象業務画面を再読込する。

required host permissionは持たず、`https://*/*`はoptional permissionとしてだけ宣言する。許可済みの完全一致host originへ
content scriptをprogrammatic registrationする。profile削除時は不要になったorigin permissionとprofile固有stateを除去する。

## credentialとstorage

API keyは`chrome.storage.session`にだけ保存し、`local`、`managed`、DOM、content script message、logへ出さない。
session storageはbrowser再起動、拡張機能のreload/update/disableで消えるため、再度unlockが必要である。Redmine 401では
`redmine.invalid_api_key`を返して即時lockする。手動lockやprofile削除でもcredentialを削除する。

`local`へ保存するのはprofile、follow/read state、冪等retry用pending intentだけである。draftとAPI keyはsession、thread本文・journal・
attachment bytesは保存しない。local/session/managed storage access levelを`TRUSTED_CONTEXTS`へ制限し、content scriptから直接読ませない。
draftとpending intentはprofileとprincipal scope hashで分離し、pending intentは7日後に削除する。

optionsの「local diagnosticをdownload」は、service worker memoryにある直近100 operationのrequest ID、operation、
profile ID、HTTP status、duration、error codeだけをJSON化する。本文、thread ID、host principal、filename、API keyは含めず、
browser再起動で消去する。remote telemetryは送信しない。

## message・network境界

content scriptとservice worker間のoperation、client state、evidence/attachment streamはversion付きの閉じたmessage契約を使う。
sender extension ID、tab URLのorigin、profile ID、request ID、payload fieldを検証し、unknown propertyや任意URL operationを拒否する。

Redmine fetchはprofileのbase URL、固定method/path/headerだけを使用し、redirectを拒否する。attachment URLもsame origin/base pathへ固定する。
service workerだけがAPI keyを`X-Redmine-API-Key`へ設定する。content scriptはShadow DOMへ共通UIを1回だけmountし、host CSSを
security boundaryとはみなさないが表示干渉を分離する。

スクリーンショットは利用者が確認・同意した場合だけ送る。evidence bytesはPortをchunk転送し、上限、content type、SHA-256、
request IDを照合する。拡張UI自身はcapture対象から除外する。

## managed policy運用

Chrome policyへ設定する`profiles`は`managed-policy.example.json`と同じJSON stringである。配布先browserが読み込んだ値は
`chrome://policy`で確認する。profileを更新するとservice workerが登録対象originを同期する。個人API keyはpolicyへ配布せず、
各利用者がRedmineから取得してsessionごとに入力する。

## 検証

```bash
npm --workspace @feedback/redmine-extension run typecheck
npm --workspace @feedback/redmine-extension run test
npm --workspace @feedback/redmine-extension run build
bash scripts/check-feedback-redmine-security.sh
```

security gateはmanifest permission/CSP、managed schema、ZIP再現性、remote code/source map/test key混入、厳格CSPとhostile CSS下の
Chrome headless、session-only credential、reload時の一重mount、non-root gateway containerを確認する。
