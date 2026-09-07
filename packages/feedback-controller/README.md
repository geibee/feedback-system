# @geibee/feedback-controller

ReactとWeb Componentが共有するheadless controllerです。frozen snapshot／commandに対するstate machineを実装し、client、browser state、clock、scheduler、visibility、ID生成、navigation、captureを注入できます。

draft、follow、unread ordering key、pending intentは端末内stateであり、端末間同期を保証しません。attachment upload結果不明時は`manual-confirmation`とし、自動再送を表現しません。

`createFeedbackController()`はfrozen `FeedbackControllerPort`に、browser composition用の実装portを加えて返します。`createWriteCommand()`は現在のscope、認可、provider capabilityを検証し、注入したID生成とdomain-separated SHA-256でsubmit／reply／revise／upload commandを構成します。capture成功結果はgeneration検証後に保持し、upload commandへ同じsourceを一回だけ渡します。cancel、disconnect、destroy後の遅延captureは保持しません。

`createBrowserFeedbackControllerState`は`feedback.v2:${origin}:${profileId}:${clientScopeId}:client-state`へdraft、follow、unread ordering key、pending recovery metadataを保存します。`clientScopeId`はcomposition rootが現在の利用者境界から与えます。storage拒否時だけpage lifecycle内memoryへ退避し、storage eventによる端末／tab同期は行いません。legacy v1からは安全に写像できるdraftとfollowだけを読み、provider journal IDをv2 stable event IDへ推測変換しません。scopeとrequest hashが不足するv1 pending intentは推測移行しません。
