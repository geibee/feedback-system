# Feedback Redmine Quickstart

目的に応じて、次のどちらか一方から開始する。

| 目的 | 開始位置 |
| --- | --- |
| このrepositoryのデモをローカルで評価する | [A. source checkoutで評価する](#a-source-checkoutで評価する) |
| 既存のReact SPAへ公開packageを組み込む | [B. 新規SPAへ組み込む](#b-新規spaへ組み込む) |

標準構成はReact SPA、same-origin gateway、Redmineからなる。Feedback専用DB、object storage、browser拡張機能は使用しない。
既存Redmineの準備と本番配備は[`feedback-redmine-installation.md`](feedback-redmine-installation.md)を参照する。

## A. source checkoutで評価する

この経路は専用のRedmine 7.0.0とPostgreSQL 17.6をDocker上へ作成する。既存または顧客のRedmineを変更する経路ではない。

### 前提条件

- Node.js 22.12以上25未満
- npm
- Docker Engine
- Docker Compose v2（`docker compose`）
- `127.0.0.1:4173`と`127.0.0.1:3001`を利用できること

repository rootで起動する。

```bash
npm ci
npm run feedback:redmine:local
```

起動に成功すると、次を利用できる。

- Feedbackデモ: `http://127.0.0.1:4173`
- Redmine管理画面: `http://127.0.0.1:3001`
- Redmineログイン名: `admin`
- Redmine password: 実行時にランダム生成され、次のコマンドで確認する

```bash
node packages/feedback-redmine-ops/dist/cli.js local credentials
node packages/feedback-redmine-ops/dist/cli.js local status
```

デモで位置を選んで投稿し、Redmine issueが作成され、双方からの返信が同じthreadへ反映されれば評価成功である。
評価を止めるときは、repository rootで次を実行する。

```bash
node packages/feedback-redmine-ops/dist/cli.js local down
```

`.feedback-redmine`にはAPI keyやランダム生成したpasswordが含まれる。共有、commit、artifactへの添付をしてはならない。
volumeを含むデータ削除は通常の停止とは別操作であり、必要な場合だけ完全な導入手順を確認して実行する。

## B. 新規SPAへ組み込む

### 前提条件

- React 18または19を使うSPA
- Node.js 22.12以上25未満とnpm
- 利用するversionのpackageがGitHub Packagesへ公開済みであること
- GitHub Packagesの`read:packages`権限を持つpersonal access token（classic）を、環境変数またはCI secretから利用できること
- 構成済みRedmineと、SPAと同じoriginで公開したFeedback gateway

Redmine API key、Redmine URL、participant署名鍵はserver-side secretである。SPA、`.npmrc`、runtime configへ記載しない。

### 1. GitHub Packagesからinstallする

プロジェクトの`.npmrc`へregistryと環境変数参照だけを記載する。

```ini
@geibee:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

`NODE_AUTH_TOKEN`にはGitHub Packagesの`read:packages`権限を持つpersonal access token（classic）を、shell環境またはCIのsecret機能から注入する。
tokenの値を`.npmrc`、shell script、Dockerfile、source codeへ保存しない。

```bash
npm install @geibee/redmine-plugin@1.0.0-alpha.3
```

ReactとReact DOMはpluginのpeer dependencyであり、SPAが既に使用している18または19を共有する。

### 2. gatewayをsame-originで配備する

SPA packageと同じversionのGitHub Releaseから`release-manifest.json`を取得し、gatewayの`indexDigest`を確認する。
配備ではversion tagではなく、そのdigestへ固定してGHCRから取得する。

```bash
GATEWAY_DIGEST='sha256:release-manifestの値へ置換'
docker pull "ghcr.io/geibee/feedback-redmine-gateway@$GATEWAY_DIGEST"
```

gatewayにはserver profile、Redmine integration API key、32 bytes以上のparticipant署名鍵をserver-side secretとして注入する。
imageの8080 portを利用者networkへ直接公開せず、SPAと同じoriginの`/internal/feedback-redmine/v1`へreverse proxyする。
設定項目とhealth checkは[`feedback-redmine-installation.md`](feedback-redmine-installation.md)の本番gateway手順に従う。

### 3. runtime configを配備する

SPAと同じoriginの`/.well-known/feedback-redmine.json`から、次のJSONを`Content-Type: application/json`かつ
`Cache-Control: no-store`で返す。

```json
{
  "schemaVersion": "1",
  "enabled": true,
  "profileId": "inventory-production",
  "gatewayBasePath": "/internal/feedback-redmine/v1"
}
```

`gatewayBasePath`はsame-originのroot-relative pathだけを指定できる。`enabled:false`ではUI、gateway通信、timer、router購読を開始しない。
subpath配備では、後述のcontroller作成時に`configPath`を明示する。

### 4. Host Adapterを作る

次はDOM画面だけで動作する最小例である。値はHost製品の安定した識別子へ置き換え、個人情報や認証情報を渡さない。
同じ実装はconsumer fixtureの
[`quickstart-adapter.ts`](../tests/fixtures/feedback-redmine-plugin-vanilla/src/quickstart-adapter.ts)で常にtypecheckする。

```ts
import type { RedmineFeedbackRuntimeOptions } from "@geibee/redmine-plugin/loader";

const locationSubscribers = new Set<() => void>();

export function createQuickstartAdapter(): RedmineFeedbackRuntimeOptions["adapter"] {
  return {
    getContext: () => ({
      schemaVersion: "1",
      applicationKey: "inventory",
      environmentKey: "production",
      externalWorkspaceKey: "production-review",
      release: "app-release",
      locale: "ja-JP"
    }),
    getLocation: () => ({
      schemaVersion: "1",
      pageKey: "orders.detail",
      routeTemplate: "/orders/{orderId}",
      pathParameters: { orderId: "sha256:replace-with-non-sensitive-value" }
    }),
    getResourceRef: () => ({
      schemaVersion: "1",
      kind: "record",
      key: "order:replace-with-stable-key"
    }),
    subscribe: (listener) => {
      locationSubscribers.add(listener);
      return () => locationSubscribers.delete(listener);
    },
    navigate: () => undefined
  };
}

export function emitQuickstartLocationChange(): void {
  locationSubscribers.forEach((listener) => listener());
}
```

- SPA routerが画面を変更したら`emitQuickstartLocationChange()`を呼び出す。
- `navigate`は保存済みthreadから別画面へ移動するHost router処理へ置き換える。
- `pathParameters`とresource keyには、生値ではなくHost側で安定化・仮名化した値を使う。
- `data-feedback-key="stable-element-key"`を付けたDOM要素は、画面座標だけでなく要素内相対位置として保存される。
- `data-feedback-exclude`は証跡から要素を除外し、`data-feedback-mask`は最終PNG上で対象領域を黒塗りする。

### 5. React lifecycleへ接続する

`FeedbackIntegration`をアプリケーションrootで一度renderする。基本例では`targetResolver`や`pinPositionProvider`を指定しないため、
DOM要素または画面相対位置だけで完結する。同じコードはconsumer fixtureの
[`quickstart-react.ts`](../tests/fixtures/feedback-redmine-plugin-vanilla/src/quickstart-react.ts)でReact 18／19に対してtypecheckする。

```tsx
import { useEffect } from "react";
import { createRedmineFeedbackPluginControllerFromRuntimeConfig } from "@geibee/redmine-plugin/loader";
import type { RedmineFeedbackPluginController } from "@geibee/redmine-plugin/loader";
import { createQuickstartAdapter } from "./quickstart-adapter.js";

const adapter = createQuickstartAdapter();

export function FeedbackIntegration(): null {
  useEffect(() => {
    const abort = new AbortController();
    let controller: RedmineFeedbackPluginController | null = null;

    void createRedmineFeedbackPluginControllerFromRuntimeConfig({
      adapter,
      contextMenu: true,
      signal: abort.signal,
      onUnavailable: (error) => console.error("Feedbackを利用できません", error)
    }).then((created) => {
      if (abort.signal.aborted) created?.destroy();
      else controller = created;
    });

    return () => {
      abort.abort();
      controller?.destroy();
    };
  }, []);

  return null;
}
```

`AbortSignal`と`destroy()`は、React StrictMode、route遷移、microfrontend破棄後の遅延mountや購読残留を防ぐ。
一時停止はruntime configを`enabled:false`へ変更する。完全撤去時だけcontrollerの`purgeLocalState()`を先に呼び、
participant credential、draft、follow状態を削除する。Redmine上のissue、journal、attachmentは削除されない。

### 6. 接続を確認する

1. browserのNetworkでruntime configが200と`application/json`を返す。
2. `enabled:true`で「フィードバック」launcherが1個だけ表示される。
3. 位置を選んで投稿すると、same-originの`gatewayBasePath`だけへrequestが送られる。
4. Redmineにissueが作成され、SPAとRedmineの返信が同じthreadへ反映される。
5. `enabled:false`へ変更して再読込すると、launcherとgateway通信が消える。

## 任意連携: MapLibre

地理座標、地物への追従、WebGL証跡が必要な場合だけ`@geibee/maplibre`と`maplibre-gl`を追加し、
`targetResolver`、`pinPositionProvider`、必要に応じて`captureEvidence`をcontroller optionへ渡す。
基本導入には不要である。実装例は[`@geibee/maplibre README`](../packages/feedback-maplibre/README.md)を参照する。

## 任意連携: custom target

Canvas、Three.js、chartなど独自rendererの対象を保持する場合だけ、`targetResolver`から`kind:"custom"`、名前空間付き`provider`、
安定した`targetKey`、画面相対fallback座標を返す。保存済み対象の現在位置は同じcontrollerへ渡す`pinPositionProvider`で解決し、
解決不能時はfallback位置へ表示される。DOMだけの基本導入では使用しない。

## 次に読む文書

- Redmine準備、本番配備、backup、upgrade: [`feedback-redmine-installation.md`](feedback-redmine-installation.md)
- Redmine projectとcustom fields: [`redmine-integration.md`](redmine-integration.md)
- gateway SPIとsame-origin境界: [`redmine-gateway.md`](redmine-gateway.md)
- reverse proxy: [`reverse-proxy.md`](reverse-proxy.md)
- Legacy Feedback Service: [`legacy-quickstart.md`](legacy-quickstart.md)
