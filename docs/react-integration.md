# React組み込み

React 18/19では `@feedback/core` のHostAdapterとtransportを作成し、`@feedback/react` の
`FeedbackProvider` / `FeedbackErrorBoundary` / `FeedbackOverlay` を業務画面の一部へ配置する。
SDK全体でrouter、認証、workspace解決を所有せず、HostAdapterから受け取る。

Service障害時はErrorBoundaryと `FeedbackUnavailable` がFeedback subtreeだけを縮退させる。
業務画面の描画やナビゲーションをtoken取得の完了へ依存させない。MapLibreを使う場合だけ
`@feedback/maplibre` を追加する。他フレームワークは `@feedback/core` とHTTP契約を利用する。

Feedback Buttonは対象選択modeへ切り替わり、次にクリックした位置で投稿画面を開く。DOM部品へ安定して
pinを追従させる場合は`data-feedback-key`へapplication内で一意なkeyを設定する。keyを持たない位置は
viewport相対のscreen-positionとして保存する。右クリック投稿を有効にする場合は
`FeedbackProvider`へ`features={{ contextMenu: true }}`を渡す。

`data-feedback-map`を付けた領域も右クリックを無視せず、resolver未指定時はscreen-positionとして扱う。
MapLibreの地理座標／地物をtargetへ保存する場合は`FeedbackOverlay.targetResolver`を設定する。

```tsx
import { resolveMapLibreFeedbackTargetAtClientPoint } from "@feedback/maplibre";

<FeedbackOverlay targetResolver={(input) => {
  const map = mapRef.current;
  if (!map || !input.element?.closest("[data-feedback-map]")) return null;
  return resolveMapLibreFeedbackTargetAtClientPoint(map, input, {
    layers: feedbackLayerIds,
    toSourceKey,
    toFeatureKey
  });
}} />;
```

resolverが`null`を返す領域は通常のDOM／screen targetへfallbackする。

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
import { createMapLibreEvidenceProvider } from "@feedback/maplibre";
import { createDomEvidenceProvider } from "@feedback/react";

adapter.captureEvidence = createMapLibreEvidenceProvider({
  capture: createDomEvidenceProvider(),
  maps: () => mapRef.current ? [mapRef.current] : []
});
```

撮影対象rootにMapLibre containerを含め、cross-origin tile／画像はCORS対応させる。常時
`preserveDrawingBuffer: true`にする方式も利用できるが、描画性能とmemory消費へ影響するため、通常は上記providerを
使用する。詳細は`packages/feedback-maplibre/README.md`を参照する。

「他の人の投稿を見る」はsession内のthreadを画面単位で表示する。選択時はHostAdapterの`navigate`完了後に
Thread Drawerを開く。現在locationに一致するDOM／screen threadは番号付きpinとして表示し、hostのscroll、
resize、DOM更新へ追従する。Thread Drawerや投稿一覧を開いている間もpinを維持し、開いているthreadを強調する。
