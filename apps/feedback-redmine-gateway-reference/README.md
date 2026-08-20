# Feedback Redmine gateway reference

`@feedback/redmine-gateway`の公開participant modeをNode.js HTTP serverへ接続する最小例です。host session、OIDC JWT、
固定principal、Feedback専用DBは使用しません。

`FEEDBACK_REDMINE_GATEWAY_PROFILE_FILE`へread-only server profile JSONのabsolute pathを指定します。`clientProfileRef`は
同じdirectoryからのrelative pathまたはabsolute pathです。`FEEDBACK_REDMINE_GATEWAY_API_KEY`へRedmine integration user key、
`FEEDBACK_PARTICIPANT_SIGNING_KEY`へ32 bytes以上のparticipant/message署名鍵を設定します。いずれのsecretも既定値はなく、未設定時は
起動前にfail-fastします。

participant credentialは同一origin・profile・browser profileの自己編集所有確認にだけ使います。読み取り、新規投稿、返信を制限する
authenticationではありません。公開範囲を限定する場合は、このreference serverの外側へアクセス制御を追加してください。

このreference appはDB、ORM、queue、cache、upload directoryを使用しません。実環境ではhandlerを業務アプリの既存認証
same-origin routeとして直接組み込む構成を推奨します。
