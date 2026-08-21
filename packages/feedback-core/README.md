# @geibee/feedback-core

React、DOM、MapLibre、特定routerに依存しない Feedback SDK の中核です。`FeedbackHostAdapter`、v1 fetch
transport、manifest/location/target の解決・検証、capabilities negotiation を提供します。

```ts
import { createFeedbackTransport, type FeedbackHostAdapter } from "@geibee/feedback-core";
```

token は host adapter から受け取り、401 refresh は single-flight で実行します。書き込み時の
`Idempotency-Key` と更新時の `If-Match` は transport option で明示します。
`request`、`requestBinary`、`getCapabilities`、`getReviewContext`は任意の`AbortSignal`をfetch adapterへ渡します。
manifest から location を解決するとき、未登録 query と `discard` 指定 query は Service へ送る前に除外します。

SPAでrouteまたはworkspaceが変わる場合は、任意の`FeedbackHostAdapter.subscribe`から変更を通知します。listenerを
呼ぶ前に`getContext`と`getLocation`が新しい値を返すようにし、購読解除関数でrouter listenerを解放してください。
`subscribe`を実装しない既存adapterは初回のcontext取得だけを行うため、後方互換です。

```ts
const adapter: FeedbackHostAdapter = {
  getContext: () => currentContext(),
  getLocation: () => currentLocation(),
  subscribe: (listener) => router.subscribe(listener),
  // token、navigateなどの実装
};
```
