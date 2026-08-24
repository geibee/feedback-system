# MapLibre連携

この文書はMapLibreを使う画面だけが対象です。先に[`SPA導入ガイド`](spa-integration-guide.md)の確認まで完了してください。

必要な機能だけ追加します。

| やりたいこと | 追加する設定 |
| --- | --- |
| スクリーンショットに地図を写す | `controller.registerMapLibreMap(map)` |
| Feedbackを経緯度や地物IDへ関連付ける | 上記に加えて`targetResolver`と`pinPositionProvider` |

地物連携のAPIを直接importするため、gatewayとpluginに揃えたversionをSPAの直接依存へ追加します。

```bash
export FEEDBACK_REDMINE_VERSION='1.0.0-alpha.6'
npm install "@geibee/feedback-maplibre@${FEEDBACK_REDMINE_VERSION}"
```

## 1. スクリーンショットに地図を写す

MapLibreのmapを作成した後に登録し、mapを破棄する前に解除します。

```tsx
useEffect(() => {
  if (!feedbackController || !map) return;
  return feedbackController.registerMapLibreMap(map);
}, [feedbackController, map]);
```

複数の地図がある場合は、すべて登録します。通常は`preserveDrawingBuffer`を有効にする必要はありません。

投稿して、Redmineの添付画像に次が写っていることを確認します。

- 地図
- MarkerとPopup
- NavigationControlなどのcontrol

地図が白紙になる場合は、mapが登録済みか、tileとstyle画像がCORSを許可しているかを確認します。

## 2. 経緯度や地物IDへ関連付ける

地図上のFeedbackを、単なる画面座標ではなく経緯度または地物IDとして保存したい場合だけ追加します。

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

`targetResolver`と`pinPositionProvider`を`createRedmineFeedbackPluginControllerFromRuntimeConfig()`のoptionへ渡します。

```ts
const controller = await createRedmineFeedbackPluginControllerFromRuntimeConfig({
  adapter,
  targetResolver,
  pinPositionProvider
});
```

地図のcontainerには`data-feedback-map`を付けます。

```tsx
<div ref={mapContainerRef} data-feedback-map />
```

`sourceKey`と`featureKey`には、style変更や再配備後も同じ地物を指す業務IDを使用します。配列のindexや描画順は使わないでください。

最後に次を確認します。

1. 地物を選んでFeedbackを投稿する。
2. 地図を移動しても保存済みpinが同じ経緯度へ追従する。
3. 対象layerがない場所では通常の画面座標として投稿できる。
4. mapを破棄した後に古いpinが残らない。

複数layerや独自providerの型は[`@geibee/feedback-maplibre` README](../packages/feedback-maplibre/README.md)を参照してください。
