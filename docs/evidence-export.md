# 証跡エクスポート

> **Legacy Feedback Service:** この文書は従来Admin Consoleとexport worker向けです。Redmine正本構成の証跡は
> Redmine attachmentに保存します。

管理画面の「保存・エクスポート」で「証跡パッケージ（Power BI向けZIP）」を選ぶと、認可対象workspaceの
レビュー記録を1つのZIPとして出力する。`sessionId`をAPIで指定した場合は、そのレビューセッションだけを対象にする。

## 内容

ZIPには次の正規化CSVを`data/`配下へ格納する。CSVはUTF-8 BOM付きで、表計算式として解釈される値を
無効化する。認証・認可の監査ログは含めない。

| ファイル | 主な内容 | 主キー・結合キー |
| --- | --- | --- |
| `sessions.csv` | レビューセッション | `session_id` |
| `session_scopes.csv` | 対象画面 | `scope_id`, `session_id` |
| `session_scope_perspectives.csv` | 画面別の確認観点 | `scope_id`, `perspective_code` |
| `session_perspectives.csv` | セッションの観点 | `session_id`, `code` |
| `threads.csv` | スレッド、担当者、優先度 | `thread_id`, `session_id` |
| `thread_labels.csv` | スレッドのラベル | `thread_id` |
| `messages.csv` | 現在の全コメント | `message_id`, `thread_id` |
| `message_versions.csv` | コメントの全編集履歴と現行版 | `message_id`, `thread_id` |
| `status_events.csv` | 作成・解決・再オープン履歴 | `thread_id` |
| `triage_events.csv` | 担当者・優先度・ラベルの変更履歴 | `event_id`, `thread_id` |
| `reactions.csv` | 現在のリアクション | `message_id`, `thread_id` |
| `reaction_events.csv` | リアクション追加・解除履歴 | `event_id`, `message_id` |
| `evidence.csv` | 画像のサイズ、SHA-256、取得日時、ZIP内path | `evidence_id`, `thread_id` |

証跡画像は`evidence/{thread_id}/{evidence_id}.png`または`.webp`に格納する。ルートの`manifest.json`には
scope、生成日時、各CSV・画像のbyte数とSHA-256を記録する。生成時にもobject storage上の画像とDBに保存した
SHA-256を照合するため、欠損または不一致があるjobは成功扱いにしない。

## Power BIでの利用

ZIPを任意の専用フォルダーへ展開し、Power BI Desktopの「フォルダー」または「テキスト/CSV」コネクタから
`data/`を読み込む。各表は上表のIDで1対多のリレーションを設定できる。たとえば、セッション別・観点別の未解決件数、
優先度と担当者別の滞留、返信時間、ラベル別件数、リアクション数、解決までの状態遷移を可視化できる。

画像の相対pathとSHA-256は証跡の照合に使える。Power BI上で画像自体を表示する場合は、利用環境で許可された
data URIまたはアクセス制御されたURLへ変換する処理を別途用意する。ZIP内の相対pathをそのまま画像URLとしては扱わない。

この形式は業務上のレビュー証跡を持ち出すためのもので、自動バックアップの代替ではない。復旧目的には
フル・差分バックアップを使用する。
