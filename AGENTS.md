# 開発ガイド

- ドキュメント、コメント、コミットメッセージは日本語、コード識別子は英語で記述する。
- 公開契約は `contracts/feedback`、Feedback本文、会話、証跡、操作回復metadataは契約済みticket管理システムを正本とする。
- Feedback ServiceはDB、queue、persistent／shared application data cache、upload directory、private object storageを使用せず、ホストDBも直接参照しない。provider profileはread-only設定、credentialと署名鍵はserver-side secretから読み込む。有界なin-process JWKS／provider metadata cacheは正本とせず、再起動で破棄できるものに限る。
- 認可はserver profileごとに`public-profile`、直接OIDC／契約済みtoken exchange JWTによる`signed-grant`、契約済み認可APIによる`remote-authorization`のいずれかへ固定する。権限はその認可結果、server profile policy、backend capabilityの積集合とし、mode fallbackを許さない。
- APIまたはDTOを変えたらOpenAPI、生成型、互換性文書を同じ変更で更新する。
- 設定を追加したら `docs/environment-variables.md` を更新し、secretに既定値を実装しない。
- 検証入口は `bash scripts/verify-feedback.sh`。未検証を成功として扱わない。
