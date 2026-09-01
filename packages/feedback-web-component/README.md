# @geibee/feedback-web-component

`@geibee/feedback-controller`だけに依存する標準rendererです。`defineFeedbackWebComponent()`で`<geibee-feedback>`を登録し、open Shadow DOMへcontroller snapshotを描画します。DOM eventはfrozen commandへだけ変換し、React、provider、transport、storageへ依存しません。

`createFeedbackPlugin()`はframework非依存のintegration ownerです。controller factoryを一度だけ呼び、scope付き`connect`、mount、refresh、thread表示、購読解除、`destroy`を扱います。同一Elementへの二重mountは拒否し、破棄後callbackをhostへ通知しません。

組込みstyleはShadow DOM内に閉じ、inline event handler、`style`属性、`eval`を使用しません。strict CSPでは`styleNonce`を渡すか、`unstyled: true`としてhostが許可済みstylesheetを提供します。launcher／modal dialogはEscape、Tab focus loop、close後のfocus復帰、ARIA label／live regionを持ちます。

controllerがbrowser実装portを提供する場合は、新規投稿、返信、自己編集とcapture後のevidence uploadを同じfrozen commandへ写像します。capture cancel、選択thread変更、権限不足ではuploadを開始しません。
