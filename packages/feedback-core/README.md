# @geibee/feedback-core

React、DOM、MapLibre、特定routerに依存せず、Redmine連携で共有するtarget検証、証跡、
`FeedbackHostAdapter`の型を提供します。

```ts
import { parseFeedbackTarget, type FeedbackHostAdapter } from "@geibee/feedback-core";
```

SPAでrouteまたはworkspaceが変わる場合は、任意の`FeedbackHostAdapter.subscribe`から変更を通知します。listenerを
呼ぶ前に`getContext`と`getLocation`が新しい値を返すようにし、購読解除関数でrouter listenerを解放してください。
`subscribe`を実装しない既存adapterは初回のcontext取得だけを行うため、後方互換です。

```ts
const adapter: FeedbackHostAdapter = {
  getContext: () => currentContext(),
  getLocation: () => currentLocation(),
  subscribe: (listener) => router.subscribe(listener),
  navigate: (location, threadId) => openThread(location, threadId)
};
```
