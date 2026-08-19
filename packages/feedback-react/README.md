# @feedback/react

React 18/19 用の `FeedbackProvider`、`FeedbackOverlay`、DOM/screen／host解決pin、Thread Drawer、DOM capture provider
を提供します。利用側は `@feedback/react/styles.css` を読み込み、`@feedback/core` の host adapter と transport
を渡します。DOM captureは`@feedback/dom-capture`のAPIを後方互換のため再exportします。MapLibre は依存に含まれません。

```tsx
import { FeedbackOverlay, FeedbackProvider } from "@feedback/react";
import "@feedback/react/styles.css";

<FeedbackProvider adapter={adapter} transport={transport}>
  <FeedbackOverlay deepLinkThreadId={threadId} />
</FeedbackProvider>;
```

routeまたはworkspaceが変わるSPAでは`adapter.subscribe`を実装します。Providerは変更通知を受けると進行中の
context HTTP requestを`AbortSignal`で中断してstaleな結果を破棄し、最新の`getContext`／`getLocation`で再取得します。
Providerへroute由来の`key`を付けて全面remountする必要はありません。`subscribe`がない既存adapterも利用できます。

`FeedbackOverlay`は次のUIを`document.body`または指定した`portalTarget`へ描画します。

- 画面上の対象を選択して投稿するFeedback Button
- 対象位置に固定した番号付きDOM／screen pin
- 画面単位にまとめた「他の人の投稿を見る」一覧とdeep link遷移
- 投稿者名、画面に割り当てられたレビュー観点、コメントを入力する投稿画面
- 投稿時点のスクリーンショット取得とpreview
- 返信、編集履歴、解決／再開、private evidence previewを扱うThread Drawer
- 受付中レビューの対象画面と観点を示すレビュー案内

Feedback Buttonを押すと対象選択modeになり、次にクリックした位置を投稿対象にします。
安定したDOM要素へpinを追従させる場合は`data-feedback-key`へapplication内で一意なkeyを設定します。

```tsx
<button data-feedback-key="order.save">保存</button>
```

右クリック操作は `features.contextMenu: true` の明示時だけ有効です。`portalTarget` には通常DOMまたは
`ShadowRoot` を指定できます。strict CSP では同梱CSSを stylesheet として読み込み、`connect-src` に
Feedback Service、証跡previewを使う場合だけ `img-src blob:` を許可してください。

`data-feedback-map`配下の操作も除外せず、`targetResolver`未指定時は画面座標targetとして投稿できます。
MapLibreの地理座標／地物targetへ変換する場合は`@feedback/maplibre`の
`resolveMapLibreFeedbackTargetAtClientPoint`を`targetResolver`から呼び出します。

保存済みの`map-position`／`map-feature`をOverlayの番号付きpinとして表示する場合は、host固有の
`pinPositionProvider`を渡します。MapLibreでは`createMapLibreFeedbackPinPositionProvider(map)`を使用します。

```tsx
import {
  createMapLibreFeedbackPinPositionProvider,
  resolveMapLibreFeedbackTargetAtClientPoint
} from "@feedback/maplibre";

const pinPositionProvider = createMapLibreFeedbackPinPositionProvider(map);

<FeedbackOverlay
  pinPositionProvider={pinPositionProvider}
  targetResolver={(input) => {
    if (!input.element?.closest("[data-feedback-map]")) return null;
    return resolveMapLibreFeedbackTargetAtClientPoint(map, input, targetOptions);
  }}
/>;
```

Providerが位置を解決できないtargetは表示しません。位置変更通知を購読するため、地図の移動やresize後も同じ
Overlay pinが再配置されます。独自Providerは次の契約を実装します。`subscribe`が返す関数でhost eventの購読を
解除してください。

```ts
type FeedbackPinPositionProvider = {
  getPosition(target: FeedbackTargetV1): { x: number; y: number } | null;
  subscribe(listener: () => void): () => void;
};
```

既定DOM captureは `data-feedback-exclude` を除外し、`data-feedback-mask` を同梱CSSでマスクします。
cross-origin画像/fontはCORS対応または除外が必要です。captureを不要にする場合は
`features.evidenceCapture: false`、独自方式は `adapter.captureEvidence` を使用します。
DOM/screen pin は現在のmanifest locationと page/route/path/queryが一致するthreadだけを表示します。
Thread Drawerや投稿一覧を開いている間もpinを維持し、開いているthreadのpinを選択中として表示します。
Thread Drawerは選択中pinの反対側へ配置し、pinと地図上の対象を見ながら詳細を確認できるようにします。狭い画面では
地図を完全に覆わないコンパクトな下部sheetへ切り替えます。
Thread Drawerで別のthreadへ切り替えると以前の証跡previewを破棄します。切替前に開始した証跡取得が遅れて完了しても、
現在開いているthreadのpreviewは上書きされません。Drawerを閉じた時とOverlayを破棄した時は証跡のBlob URLを解放します。
参加中スレッドへ別の利用者から返信があると一覧ボタンと対象スレッドに未読badgeを表示します。未読数は表示中に30秒ごと、
window focus時、非表示tabの再表示時に更新し、スレッドを開くと最新メッセージまで既読にします。コメントには
👍、✅、👀、❓の固定リアクションを付けられます。

MapLibreの地図を証跡へ含める場合は`@feedback/maplibre`の`createMapLibreEvidenceProvider`で既定DOM captureを
包み、`adapter.captureEvidence`へ指定してください。MapLibreを使わないconsumerには追加依存は入りません。

自己申告名が必要なparticipant policyでは`adapter.getParticipantName`／`setParticipantName`を使います。
`createLocalStorageParticipantAdapter`はlocalStorageへの保存を明示的に選択する場合だけ利用してください。
レビュー観点はsessionで`active`なものに限定し、現在画面のscopeに`perspectiveCodes`があればさらに絞り込みます。

`features.autoIntroduction: true`ではレビュー案内をsessionごとに初回表示します。既読keyを変更する場合は
`FeedbackOverlay`の`reviewIntroductionStorageKey`、受付中sessionがない場合に管理画面への導線を表示する場合は
`reviewManagementUrl`を指定します。

主要な配色と配置は`--feedback-accent`、`--feedback-launcher-bg`、`--feedback-pin`、
`--feedback-panel-width`、`--feedback-launcher-right`、`--feedback-launcher-bottom`などのCSS custom propertyで
host applicationから調整できます。
