# Feedback Redmine gateway server

`@geibee/feedback-redmine-gateway`の公開participant modeをNode.js HTTP serverへ接続した標準配布serverです。host session、OIDC JWT、
固定principal、Feedback専用DBは使用しません。

`FEEDBACK_PUBLIC_ORIGIN`へSPAの正確な公開origin、`FEEDBACK_REDMINE_GATEWAY_PROFILE_FILE`へread-only server profile JSONのabsolute pathを指定します。`clientProfileRef`は
同じdirectoryからのrelative pathまたはabsolute pathです。`FEEDBACK_REDMINE_GATEWAY_API_KEY`または
`FEEDBACK_REDMINE_GATEWAY_API_KEY_FILE`のどちらか一方へRedmine integration user keyまたはsecret fileのabsolute path、
`FEEDBACK_PARTICIPANT_SIGNING_KEY`へ32 bytes以上のparticipant/message署名鍵を設定します。いずれのsecretも既定値はなく、未設定時は
起動前にfail-fastします。

participant credentialは同一origin・profile・browser profileの自己編集所有確認にだけ使います。読み取り、新規投稿、返信を制限する
authenticationではありません。公開範囲を限定する場合は、このreference serverの外側へアクセス制御を追加してください。

このserverはDB、ORM、queue、cache、upload directoryを使用しません。OCI imageはnon-rootで、read-only root filesystem、
`cap_drop: ALL`、`no-new-privileges`で実行できます。health endpointは
`/internal/feedback-redmine/v1/health/live`と`/health/ready`です。

完全な導入手順は`docs/feedback-redmine-installation.md`を参照してください。
