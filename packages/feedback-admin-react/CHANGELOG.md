# Changelog

## Unreleased

- 証跡モーダルをbackdrop clickとEscapeで閉じられるようにし、モーダル内部の操作では閉じないようにしました。
- Exportの状態取得に一時的に失敗しても、1秒から最大10秒のbackoffで自動追跡を継続し、復旧後に通常間隔へ戻すようにしました。
- 選択したthreadの証跡をthread番号・観点・読込状態とともに専用モーダルへ表示し、thread切替時の古いpreview破棄と遅延responseの競合排除に対応しました。
- CSV／XLSX Export作成後のjobを完了まで自動追跡し、作成時の形式で完了ファイルを自動ダウンロードするようにしました。
- Exportの失敗内容を表示し、状態取得またはダウンロードに失敗したjobを保持して手動再確認／再ダウンロードできるようにしました。
- レビューセッション作成・編集フォームを画面幅に合わせて拡張し、4列の基本設定、カード型の対象画面選択、固定操作バーへ改善しました。
- 「対象アプリでスレッドを開く」でworkspaceとthreadを含むURLを確実に開き、非同期取得時のポップアップ制限を回避しました。
- 旧Webhook互換フォームを管理画面から除去し、通知コネクタへ一本化しました。
- 管理画面全体のボタン、ナビゲーション、見出し、タイポグラフィを刷新しました。

## 1.0.0-alpha.1

- 独立Admin Console向けのsession/thread/evidence/manifest/retention/membership管理UIを追加。
- server-side CSV/XLSX export、対象アプリdeep link、notification retry管理を追加。
