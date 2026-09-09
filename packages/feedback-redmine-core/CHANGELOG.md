# Changelog

## 1.0.0-rc.3 - 2026-09-09

- RC.2で判明したOCI imageのbuild時刻依存を除去し、同一commitの再buildで同じdigestを生成する。公開APIと実行時挙動は変更しない。

## 1.0.0-rc.2 - 2026-09-08

- RC.1 release集合のstale build混入を解消するclean rebuild。Redmine v1互換と公開APIは変更しない。

## 1.0.0-alpha.7 - 2026-08-30

- v2 dual-write ticketのUUIDv7／UUIDv8識別子をv1 readerでも保持できるよう、UUID検証をRFC 9562のversion範囲へ広げました。
- document／名前付きscroll領域targetとcustom fallbackをRedmine locatorからfail-closedで復元するようにしました。
- 親チケット・期限・重要度をrequest hash、context attachment、Redmine issue作成へ追加し、親projectとactive priorityを検証するようにしました。

- 新規Redmine issueの証跡画像を添付したままdescription内にもclick可能なthumbnailとして表示し、SPA URLを
  CommonMarkとTextileの双方で自動linkになる安全な形式で保存するようにしました。

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
