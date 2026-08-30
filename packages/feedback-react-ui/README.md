# @geibee/feedback-react-ui

Redmine UIで使うDOM target解決プリミティブです。`data-feedback-key`を正規の要素キー属性とし、
見つからない場合は`data-feedback-scroll-key`付きの最寄りscroll領域のcontent座標、さらに外側では
document座標へfallbackします。座標はv1のunionを拡張せず、providerが`io.github.geibee.feedback.dom`の
`custom` target metadataへ保存します。`fallbackRelativeX/Y`も併記するため旧gateway／旧UIと互換です。
保存済み`screen-position`の表示互換はRedmine UI側で維持します。
