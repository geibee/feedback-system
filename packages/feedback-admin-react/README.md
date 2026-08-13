# @feedback/admin-react

Feedback Service v1だけを利用する独立管理UIです。導入先の業務API、DB、route、OIDC audienceには依存しません。
session/scope/perspective、thread/evidence/deep link、manifest、retention、membership、notification delivery、
server-side CSV/XLSX exportを管理できます。

```tsx
import { FeedbackAdminConsole } from "@feedback/admin-react";
import "@feedback/admin-react/styles.css";

<FeedbackAdminConsole
  transport={transport}
  applicationKey="consumer-app"
  environmentKey="production"
  externalWorkspaceKey="workspace-1"
/>;
```

threadの証跡は専用モーダルに表示され、選択したthread番号と観点を確認できます。別のthreadや証跡へ切り替えた
場合は以前のpreviewを破棄し、先に開始した取得が遅れて完了しても現在の選択を上書きしません。モーダルには読込中／
失敗状態と閉じる操作が表示され、閉じるボタン、モーダル外のbackdrop click、Escapeで閉じられます。モーダル内部の
操作では閉じず、閉じた証跡のBlob URLは解放されます。

CSV／XLSX Exportを作成すると、jobが`queued`／`running`の間は完了まで自動追跡し、`completed`になった時点で
作成時に選択した形式のファイルを自動ダウンロードします。`failed`ではserverから返されたエラーを表示します。
状態取得に一時的に失敗した場合も1秒から最大10秒のbackoffで自動追跡を継続し、成功時に通常間隔とエラー表示へ
復帰します。ダウンロードに失敗したjobも画面に保持されるため、手動で状態を再確認し、完了済みファイルを再度
ダウンロードできます。完了時の自動ダウンロードはjobごとに一度だけ行い、処理中は同じ画面からExportを重複作成
できません。

正式配布先が承認されるまでは `private: true` を維持し、repository内のAdmin Consoleからworkspace参照します。
