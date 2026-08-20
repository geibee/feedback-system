# React組み込み

> **Legacy Feedback Service:** この文書は`@geibee/react`と`/feedback/v1`の従来組み込み向けです。
> 新規SPAは`@geibee/redmine-plugin/loader`を使う[`quickstart.md`](quickstart.md)を参照してください。

React 18/19では `@geibee/core` のHostAdapterとtransportを作成し、`@geibee/react` の
`FeedbackProvider` / `FeedbackErrorBoundary` / `FeedbackOverlay` を業務画面の一部へ配置する。
SDK全体でrouter、認証、workspace解決を所有せず、HostAdapterから受け取る。

SPAのrouteまたはworkspace変更は、routerの変更通知を任意の`FeedbackHostAdapter.subscribe`へ接続する。
listenerを呼ぶ時点で`getContext`と`getLocation`は変更後の値を返す必要がある。Providerは通知時に進行中の
context HTTP requestを`AbortSignal`で中断して古い結果を破棄し、最新contextを再取得する。購読解除関数はrouter listenerを
解放する。Providerの`key`をrouteごとに変えて全面remountする必要はない。

```ts
const adapter: FeedbackHostAdapter = {
  getContext: () => resolveContext(router.location),
  getLocation: () => resolveLocation(router.location),
  subscribe: (listener) => router.subscribe(listener),
  // getAccessToken、navigateなど
};
```

Service障害時はErrorBoundaryと `FeedbackUnavailable` がFeedback subtreeだけを縮退させる。
業務画面の描画やナビゲーションをtoken取得の完了へ依存させない。MapLibreを使う場合だけ
`@geibee/maplibre` を追加する。他フレームワークは `@geibee/core` とHTTP契約を利用する。

Feedback Buttonは対象選択modeへ切り替わり、次にクリックした位置で投稿画面を開く。DOM部品へ安定して
pinを追従させる場合は`data-feedback-key`へapplication内で一意なkeyを設定する。keyを持たない位置は
viewport相対のscreen-positionとして保存する。右クリック投稿を有効にする場合は
`FeedbackProvider`へ`features={{ contextMenu: true }}`を渡す。

`data-feedback-map`を付けた領域も右クリックを無視せず、resolver未指定時はscreen-positionとして扱う。
MapLibreの地理座標／地物をtargetへ保存する場合は`FeedbackOverlay.targetResolver`を設定し、保存済みの
`map-position`／`map-feature`を番号付きpinとして表示する場合は`pinPositionProvider`も設定する。

```tsx
import {
  createMapLibreFeedbackPinPositionProvider,
  resolveMapLibreFeedbackTargetAtClientPoint
} from "@geibee/maplibre";

const pinPositionProvider = createMapLibreFeedbackPinPositionProvider(map);

<FeedbackOverlay
  pinPositionProvider={pinPositionProvider}
  targetResolver={(input) => {
    if (!input.element?.closest("[data-feedback-map]")) return null;
    return resolveMapLibreFeedbackTargetAtClientPoint(map, input, {
      layers: feedbackLayerIds,
      toSourceKey,
      toFeatureKey
    });
  }}
/>;
```

resolverが`null`を返す領域は通常のDOM／screen targetへfallbackする。位置Providerは保存済み経緯度を
MapLibreのcanvasへ投影し、`move`、`resize`、`styledata`へ追従する。canvas外または破棄済みの地図にあるpinは
表示しない。`map-feature`も保存時のlongitude／latitudeを使うため、現在の地物を再検索する必要はない。

投稿画面では、現在画面のreview scopeへ割り当てられたactiveなレビュー観点、participant policyに応じた
投稿者名、コメントを入力する。投稿者名を保持するhostは`getParticipantName`と`setParticipantName`を実装する。
SDK付属の`createLocalStorageParticipantAdapter`を使う場合も、hostが明示的にlocalStorage保存を選択する。

既定では対象を選択した時点で現在viewportの証跡を取得し、投稿画面にpreviewする。SDK自身と
`data-feedback-exclude`はcaptureから除外し、`data-feedback-mask`は黒塗りする。取得失敗時は理由を表示して
コメントだけの投稿を継続する。独自captureは`FeedbackHostAdapter.captureEvidence`、無効化は
`features.evidenceCapture: false`を使う。

MapLibreのWebGL canvasは既定では描画bufferを保持しない。地図、Marker、Popup、NavigationControl、
ScaleControlを証跡へ含める場合は、撮影時の再描画だけを2D canvasへ退避するproviderを設定する。

```ts
import { createMapLibreEvidenceProvider } from "@geibee/maplibre";
import { createDomEvidenceProvider } from "@geibee/react";

adapter.captureEvidence = createMapLibreEvidenceProvider({
  capture: createDomEvidenceProvider(),
  maps: () => mapRef.current ? [mapRef.current] : []
});
```

撮影対象rootにMapLibre containerを含め、cross-origin tile／画像はCORS対応させる。常時
`preserveDrawingBuffer: true`にする方式も利用できるが、描画性能とmemory消費へ影響するため、通常は上記providerを
使用する。詳細は`packages/feedback-maplibre/README.md`を参照する。

「他の人の投稿を見る」はsession内のthreadを画面単位で表示する。選択時はHostAdapterの`navigate`完了後に
Thread Drawerを開く。現在locationに一致するDOM／screen threadと、位置Providerで解決できる地図threadは
番号付きpinとして表示し、hostや地図の移動へ追従する。Thread Drawerや投稿一覧を開いている間もpinを維持し、
開いているthreadを強調する。選択中pinが地図に隠れないよう、Drawerはpinの反対側へ配置する。狭い画面では
地図の表示領域を残すコンパクトな下部sheetへ切り替える。
