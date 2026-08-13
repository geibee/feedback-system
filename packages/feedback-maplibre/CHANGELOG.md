# Changelog

## 1.0.0-alpha.1

- MapLibre featureからv1 targetへの変換adapterを追加。
- style reload、layer消滅、map unloadに対応したmarker lifecycle bindingを追加。
- browserのclient座標を地理座標／地物targetへ変換するOverlay向けhelperを追加。
- `preserveDrawingBuffer`を常時有効にせず、地図とcontrolをDOM証跡へ合成するcapture providerを追加。
- `captureReadyCanvasContextAttributes`と設定漏れ検出helperを追加。
