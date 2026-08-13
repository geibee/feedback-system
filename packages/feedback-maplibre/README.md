# @feedback/maplibre

MapLibre featureを製品横断の安定した `sourceKey` / `featureKey` へ変換し、Overlay pinの位置解決、地図markerの lifecycleと
WebGL証跡取得を管理する任意 package です。`maplibre-gl` はこの package だけの peer dependencyで、
`@feedback/react` の導入には不要です。

`bindMapLibreFeedbackPins` は style reload でmarkerを再構築し、required layer消滅時とmap unload時に
markerを破棄します。

## 地図上のclick／右クリックをtargetへ変換する

`data-feedback-map`を付けた領域も`FeedbackOverlay`は無視せず、resolver未指定時は画面座標targetとして扱います。
地理座標や地物を保持する場合は、client座標をMapLibre targetへ変換するresolverを接続します。

```tsx
import { resolveMapLibreFeedbackTargetAtClientPoint } from "@feedback/maplibre";

<FeedbackOverlay
  targetResolver={(input) => {
    const map = mapRef.current;
    if (!map || !input.element?.closest("[data-feedback-map]")) return null;
    return resolveMapLibreFeedbackTargetAtClientPoint(map, input, {
      layers: feedbackLayerIds,
      toSourceKey: (feature) => String(feature.source),
      toFeatureKey: (feature) => feature.id == null ? null : String(feature.id)
    });
  }}
/>;
```

`null`を返した領域はSDKの通常のDOM／画面座標targetへ戻ります。

## 保存済みの地図targetをOverlay pinとして表示する

`FeedbackOverlay`の番号付きpinへ`map-position`／`map-feature`を投影するには、同じMapLibre mapから
位置Providerを作成します。

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

位置Providerはtargetに保存されているlongitude／latitudeを`map.project`でcanvas座標へ変換し、canvasの
viewport位置を加えてOverlay pinの座標を返します。`map-feature`も現在のstyleやsourceから地物を再検索せず、
保存済み経緯度を使います。`move`、`resize`、`styledata`の後は位置変更を通知し、canvas外、DOMから切り離された
canvas、または削除済みmapのpinは非表示にします。Providerは`move`、`resize`、`styledata`、`remove`を内部購読し、
Overlayが`subscribe`の戻り値を呼び出すと地図eventの購読も解除されます。map削除後の`getPosition`は`null`を返します。

既存の`bindMapLibreFeedbackPins`はMapLibre Markerを直接管理したいconsumer向けに引き続き利用できます。

## 証跡へ地図とcontrolを含める

MapLibreの既定WebGL設定では描画後のbufferが保持されず、通常のDOM captureでは地図だけが白紙になることが
あります。`createMapLibreEvidenceProvider`は撮影時の`render` event内でWebGL canvasを2D canvasへ退避し、
地図、Marker、Popup、NavigationControl、ScaleControlなどをDOM全体と一緒に撮影します。

```ts
import { createMapLibreEvidenceProvider } from "@feedback/maplibre";
import { createDomEvidenceProvider } from "@feedback/react";

const captureEvidence = createMapLibreEvidenceProvider({
  capture: createDomEvidenceProvider(),
  maps: () => mapRef.current ? [mapRef.current] : []
});

const adapter = {
  // getContext、getLocation、getAccessToken、navigateなど
  captureEvidence
};
```

複数の地図が同じ画面にある場合は`maps`からすべて返します。撮影対象のDOM rootにMapLibre containerが含まれ、
tileや画像がCORS対応している必要があります。再描画が完了しない場合は証跡取得を失敗させるため、Feedback UIは
白紙画像を保存せずコメントだけの投稿へ縮退できます。

単純な代替手段として、MapLibre生成時に次の設定も利用できます。

```ts
import { captureReadyCanvasContextAttributes } from "@feedback/maplibre";

new Map({
  // ...
  canvasContextAttributes: captureReadyCanvasContextAttributes
});
```

`preserveDrawingBuffer`は描画性能とmemory消費に影響するため、通常は撮影時だけ退避するproviderを推奨します。
旧来のDOM captureを使う場合は`findUnreadableMapCanvases(document)`で設定漏れを検出できます。地図サービスの
snapshot APIなどを使う独自providerも`FeedbackHostAdapter.captureEvidence`へ指定できます。
