# @feedback/dom-capture

Feedback UIで共有するDOMスクリーンショット取得providerです。Reactへ依存せず、現在のviewport、
`data-feedback-exclude`相当の除外selector、`data-feedback-mask`相当のmask selectorを扱います。

```ts
import { createDomEvidenceProvider } from "@feedback/dom-capture";

const captureEvidence = createDomEvidenceProvider({
  maxPixelRatio: 2,
  maxBytes: 10 * 1024 * 1024
});
```

既存consumerは`@feedback/react`または`@feedback/redmine-react`から同じAPIを引き続き利用できます。
cross-origin画像やfontを含める場合は対象resourceのCORSを設定するか、capture対象から除外してください。
