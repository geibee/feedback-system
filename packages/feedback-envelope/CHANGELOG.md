# Changelog

## 1.0.0-alpha.7 - 2026-08-31

- Phase 1のEnvelope codec／key ring port skeletonを追加した。
- Phase 2でcanonical JSON、domain-separated command hash、HS256 key ring、Envelope／message／attachment署名検証、participant ID鍵分離を実装した。
- attachment markerの署名対象へ`messageId`を追加し、provider attachmentの会話内関連付けを保護した。
