# Changelog

## Unreleased

- 新規Redmine issueのSPA URLを、URL文字列をlabelにしたクリック可能なMarkdown linkとして保存するようにしました。

- browser profile UUIDを参加者IDとするcontext、participant message marker、返信journal、追記型編集、version fold、終了status判定を追加。
- Profile内Workspace一覧、一覧総件数、scopeへ束縛したcursor v2を追加し、既存resource cursor v1を維持。
- 新規issueのdescriptionを初回commentとthread URLだけにし、初回自己編集署名をcontext attachmentへ移した。旧metadata blockの読取は維持。
- `custom` targetをRedmine locatorへ保存・復元し、provider、fallback座標、scalar metadataをfail-closedで検証するようにしました。

## 1.0.0-alpha.1

- Redmine issueをFeedback threadへ正規化するtrusted connectorを追加。
- 共通Redmine port、thread model、profile検証、context/hash、DTO正規化、cursor、trusted REST clientを追加。
- strict response/client-state validator、primary evidence再構築、invalid API key写像、createの新規/回収判定を追加。
- secretや業務本文を型上保持しない最大100件のmemory diagnostic ring bufferを追加。
- draft/pending intentをprincipal scopeで分離し、pendingのprepared/uncertain状態と7日失効を追加。
