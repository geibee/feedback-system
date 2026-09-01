# @geibee/feedback-react

`@geibee/feedback-controller`へ接続するReact rendererです。`useSyncExternalStore`でsnapshotを購読し、refresh、thread選択、follow、draft、capture、navigation、intent回収をfrozen commandとして発行します。HTTP、provider DTO、storage、polling、intent再送判断は持ちません。

`FeedbackOverlay`はCSSを自動注入しません。通常DOMまたはhost所有Shadow Rootへ`installFeedbackReactStyles(root, nonce?)`で明示的に導入してください。strict CSPではnonceを渡します。

controllerがbrowser実装portを提供する場合は、新規投稿、返信、自己編集をfrozen write commandへ変換します。選択中threadで証跡captureが成功した場合だけ、独立した`feedback:attachment:upload`権限を確認して保持sourceをuploadへ渡します。cancelまたはthread変更後はuploadしません。
