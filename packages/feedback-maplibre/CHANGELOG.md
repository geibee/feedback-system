# Changelog

## 1.0.0-rc.2 - 2026-09-08

- RC.1 release集合のstale build混入を解消するclean rebuild。公開APIと実行時挙動は変更しない。

## 1.0.0-alpha.7 - 2026-08-30

- Redmine UIで使わない旧thread marker bindingを削除し、target resolverとpin position providerへ一本化しました。
- MapLibre証跡providerの識別helperを追加し、SPA pluginの未接続自動診断と連携しました。
- `maplibre-gl` peerを、証跡helperだけを利用するconsumer向けにoptionalとしました。

- `createMapLibreFeedbackPinPositionProvider(map)`を追加し、`map-position`／`map-feature`をOverlay pinへ投影できるようにしました。
- Overlay pinを`move`、`resize`、`styledata`へ追従させ、canvas外・切断済み・map削除後は非表示にするようにしました。

## 1.0.0-alpha.1

- MapLibre featureからv1 targetへの変換adapterを追加。
- style reload、layer消滅、map unloadに対応したmarker lifecycle bindingを追加。
- browserのclient座標を地理座標／地物targetへ変換するOverlay向けhelperを追加。
- `preserveDrawingBuffer`を常時有効にせず、地図とcontrolをDOM証跡へ合成するcapture providerを追加。
- `captureReadyCanvasContextAttributes`と設定漏れ検出helperを追加。
