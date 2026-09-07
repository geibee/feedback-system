# Changelog

## 未リリース - 2026-09-07

- scope別の固定参照を保存・復元し、pending intent／follow／rendererへ伝播する。並行refreshによる参照の巻戻しを防ぐ。

## 未リリース - 2026-09-06

- 最初のwrite前にpending intentを保存し、切断後も回収用ID／hashを保持する。保存例外時は送信しない。

## 1.0.0-rc.1 - 2026-09-02

- ClientStateV2、利用者scope付きbrowser local storage、v1 draft／follow readerを実装した。
- Headless Controller、visible polling、unread ordering、pending intent回収、capture／navigation cancellation、stale commit防止を実装した。
- attachment結果不明時にbinaryを再uploadせず、recoverまたはmanual confirmationだけを許可するtestを追加した。
- browser実装portでwrite ID／request hashを生成し、現在scopeと権限をfail-closed検証するcompositionを追加した。
- capture成功sourceをuploadまで保持し、cancel／disconnect／stale結果と0 byte attachmentを拒否するtestを追加した。

## 1.0.0-alpha.7 - 2026-08-31

- controller snapshot／command contractとPhase 1 golden fixtureを追加した。
- Phase 2でwrite command payload、upload source、pending intentのscope／thread／stable result、local unread state、async dispatchとbinary自動再送禁止を固定した。
