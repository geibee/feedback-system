# Feedback System

既存のReact SPAへフィードバックUIを追加し、投稿・返信・スクリーンショットをRedmineへ保存します。
Feedback専用DBやobject storageは不要です。

## ローカルで試す

Node.js 22.12以上25未満、npm、Docker Engine、Docker Compose v2が必要です。

```bash
npm ci
npm run feedback:redmine:local
```

- Feedbackデモ: `http://127.0.0.1:4173`
- Redmine: `http://127.0.0.1:3001`

```bash
# Redmineのログイン情報を表示
node packages/feedback-redmine-ops/dist/cli.js local credentials

# 終了
node packages/feedback-redmine-ops/dist/cli.js local down
```

この手順は評価専用Redmineを新規作成します。既存Redmineには実行しないでください。

## 既存のReactとRedmineへ導入する

### 1. Redmineを準備する

Feedback専用project、tracker、integration user、role、workflow、custom fieldを作成します。
Rails runnerを利用できる場合は、CLIで安全にplan／applyできます。

```bash
npx @geibee/feedback-redmine-ops@next provision extract \
  --output /secure/feedback-redmine/provision.rb
```

manifestと実行手順は[`Feedback Redmine導入・運用手順`](docs/feedback-redmine-installation.md#3-既存redmineの準備)を参照してください。

### 2. gatewayを配備する

公開済みの標準イメージを使用します。ソースからのbuildは不要です。

```bash
docker pull ghcr.io/geibee/feedback-redmine-gateway:1.0.0-alpha.6
```

gatewayをSPAと同じoriginの`/internal/feedback-redmine/v1`へreverse proxyします。
8080番portを利用者へ直接公開せず、Redmine API keyと署名鍵はserver-side secretとして渡してください。
Compose例、profile、runtime config、環境変数は[`SPA導入ガイド`](docs/spa-integration-guide.md)にまとめています。

### 3. Reactへ組み込む

```bash
npm install @geibee/feedback-redmine-plugin@next
```

[`Host Adapterの最小例`](tests/fixtures/feedback-redmine-plugin-vanilla/src/quickstart-adapter.ts)をアプリのrouterへ接続し、
plugin controllerをアプリケーションrootで一度作成します。Redmine URLやsecretをSPAへ含めないでください。

### 4. 接続を確認する

```bash
npx @geibee/feedback-redmine-ops@next doctor \
  --origin https://app.example.com \
  --profile inventory-production
```

最後にSPAから投稿し、Redmineでissue、返信、添付画像、説明欄の画像とリンクを確認すれば完了です。

## 詳細資料

- 本番配備、backup、upgrade、障害調査: [`docs/feedback-redmine-installation.md`](docs/feedback-redmine-installation.md)
- SPA、gateway、runtime config: [`docs/spa-integration-guide.md`](docs/spa-integration-guide.md)
- MapLibre／地物連携: [`docs/maplibre-integration.md`](docs/maplibre-integration.md)
- 環境変数とsecret: [`docs/environment-variables.md`](docs/environment-variables.md)
- APIとpackageの互換性: [`docs/api-compatibility.md`](docs/api-compatibility.md)
- release手順: [`docs/release.md`](docs/release.md)
- 従来Feedback Service: [`docs/legacy-quickstart.md`](docs/legacy-quickstart.md)

開発時の検証入口は`bash scripts/verify-feedback.sh`です。

## License

[MIT License](LICENSE)
