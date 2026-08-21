# MapLibre・地物連携ガイド

この文書は、MapLibreを使用するSPAで地図をスクリーンショットへ含めたり、経緯度や地物IDを
フィードバック対象として保存したりする場合だけ参照する任意拡張ガイドです。通常のWeb画面は
[`SPA導入ガイド`](spa-integration-guide.md)だけで導入でき、この設定は必要ありません。

## 連携範囲を選ぶ

| 段階 | 投稿対象 | スクリーンショット | SPA側で追加するもの |
| --- | --- | --- | --- |
| 通常DOM | DOM要素または画面座標 | provider未指定でもDOM全体を撮影 | 基本導入のみ |
| MapLibre撮影 | DOM要素または画面座標 | DOMに加えて地図、Marker、Popup、controlを撮影 | `controller.registerMapLibreMap(map)` |
| 地物単位フィードバック | 経緯度または安定した地物ID | MapLibre撮影と同じ | 上記に加えて`targetResolver`と`pinPositionProvider` |

MapLibreの登録APIはWebGL証跡の接続だけを担当します。地理座標や地物IDを保存する必要がなければ、
`targetResolver`と`pinPositionProvider`は不要です。

## MapLibreをスクリーンショットへ含める

MapLibreの既定WebGL canvasは描画bufferを保持しないため、通常DOM providerだけでは地図が白紙になることがあります。
map生成後にcontrollerへ登録し、map破棄前に戻り値を呼び出します。controllerの有効化前、読込中、無効中にも登録でき、
再有効化後のpluginへ自動的に引き継がれます。

```tsx
import type { Map as MapLibreMap } from "maplibre-gl";
import type { RedmineFeedbackPluginController } from "@geibee/feedback-redmine-plugin/loader";

export function connectFeedbackMap(
  controller: RedmineFeedbackPluginController,
  map: MapLibreMap
): () => void {
  return controller.registerMapLibreMap(map);
}
```

React componentでは、MapLibre mapを生成したeffectと同じcleanupで解除します。

```tsx
useEffect(() => {
  if (!controller || !map) return;
  return controller.registerMapLibreMap(map);
}, [controller, map]);
```

登録したmapは撮影時に再描画され、WebGL canvasを一時的な2D canvasへ退避してからDOM全体を撮影します。
複数の地図はそれぞれ登録してください。client profileでcaptureが有効なときに、bufferを保持しない
`canvas.maplibregl-canvas`が未登録のまま見つかると、pluginは「地図が白紙になる可能性があります」と通知します。
独自providerを使用する場合は`@geibee/feedback-maplibre`の`createMapLibreEvidenceProvider()`で包むと、
診断も接続済みと判定します。

常時`canvasContextAttributes.preserveDrawingBuffer=true`にする方法もありますが、描画性能とmemory消費へ影響します。
通常は遅延登録APIを使用してください。tileやstyle画像はCORS対応が必要です。

## 地物単位フィードバックを追加する

地図上のクリックを単なる画面座標ではなく`map-position`または`map-feature`として保存する場合だけ、
`targetResolver`と`pinPositionProvider`を追加します。

```ts
import {
  createMapLibreFeedbackPinPositionProvider,
  resolveMapLibreFeedbackTargetAtClientPoint
} from "@geibee/feedback-maplibre";

const targetResolver = (input: {
  element: Element | null;
  clientX: number;
  clientY: number;
}) => {
  if (!input.element?.closest("[data-feedback-map]")) return null;
  return resolveMapLibreFeedbackTargetAtClientPoint(map, input, {
    layers: ["parcels"],
    toSourceKey: () => "parcels",
    toFeatureKey: (feature) => feature.properties?.parcelId == null
      ? null
      : String(feature.properties.parcelId)
  });
};

const pinPositionProvider = createMapLibreFeedbackPinPositionProvider(map);
```

これらをcontroller作成optionへ渡します。`sourceKey`と`featureKey`には、style reloadや配備をまたいでも変わらない
業務上の安定IDを使ってください。resolverが`null`を返した場所は通常のDOM／画面座標targetへ戻ります。
詳細な型と複数layerの扱いは[`@geibee/feedback-maplibre` README](../packages/feedback-maplibre/README.md)を参照してください。

## 確認項目

1. MapLibre登録前は未接続警告が出る。
2. 登録後は警告が消え、画像に地図とcontrolが含まれる。
3. map破棄前に登録解除関数を呼び出している。
4. 地物単位を使う場合は、地図移動後も保存済みpinが経緯度へ追従する。
