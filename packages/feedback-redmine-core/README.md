# @geibee/feedback-redmine-core

Redmine issue、journal、attachment、custom fieldからFeedback threadを構築するbrowser-safeな共通coreです。
公開entryはUI向けport/modelと決定的な変換だけを含みます。Redmine API keyを受け取るREST connectorは
`@geibee/feedback-redmine-core/trusted`に分離し、server-side gatewayからだけ利用します。

DOM、React、Chrome API、Node.js組み込みmodule、filesystem、process環境には依存しません。
`RedmineDiagnosticBuffer`は許可済みmetadataだけを最大100件のmemory ring bufferへ保持し、永続化やremote送信を行いません。

trusted connectorはGETの429/5xxだけを上限付きretryし、POST結果不明時はthread検索だけで回収します。
`createThreadWithDisposition()`は確認済み新規作成を`created`、既存または結果不明の回収を`recovered`として返すため、
gatewayはOpenAPIどおり201/200を選択できます。401は`redmine.invalid_api_key`へ変換し、upstream bodyやAPI keyを公開しません。
participant replyは署名付きjournal、編集はversion付きの追記journalとして保存し、`Thread.messages`へ最新版と履歴をfoldします。
最初のコメントの編集はdescriptionとedit journalを同じRedmine PUTで更新し、終了statusでは返信だけを拒否します。
新規descriptionへは初回コメントとSPAのthread URLだけを保存し、検索用custom fieldを重複表示しません。初回自己編集署名は
`feedback-context-v1.json`へ保存し、旧description metadataも読取互換のため引き続き解析します。

thread一覧は従来のresource scopeに加え、`scope: "workspace"`でProfileに固定されたapplication、environment、
external workspace、project、tracker全体を取得できます。resource scopeの入力とcursor v1は後方互換で維持し、
Workspace cursor v2はscope、Profile、filter、sortへ束縛します。一覧結果は`totalCount`を返します。
