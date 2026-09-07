# Thread Reference v1（Feedback HTTP v2拡張）

契約版: `feedback-v2-contract-2.0.0-alpha.3`、決定日: 2026-09-07。
正本はこの規約と同directoryのOpenAPI、provider profile schema。暗号化payloadはserver内部の実装形式であり、browserへ型を公開しない。

## 保証と非保証

- DBレスを継続する。重複排除はbest-effortであり、threadIdのprovider全体での一意性、exactly-once、検索indexの完全性を保証しない。
- 参照を取得した後は、検索結果の変動に依存せず、同じprovider ticketを直接再取得する。別ticketへの自動切替は禁止する。
- createの最初のwriteでthreadId／intentId／requestHashを同時保存する規約、操作ごとのrecoverable／best-effort／unsupportedは維持する。recoverableは既存操作の回収能力であり、重複がないことの証明ではない。
- 初回createの応答喪失で参照をまだ受信できない場合、参照なし検索回収は引き続きbest-effort。検索0件で自動createしない。可視の複数候補はconflict／repair_requiredにする。
- provider停止中のoffline read、端末間同期、Backlog attachmentの新規対応は追加しない。

## Wire

- clientは `X-Feedback-Accept-Thread-Reference: 1` で受信にopt-inする。旧clientまたは参照鍵未設定profileへの従来のJSON形状は変えない。
- `threadReference` はThreadSummary／Thread、command resultとintent recovery resultの任意field。create成功ではresultとthreadの両方に同じ値を返す。発行できた場合だけ返し、nullは返さない。
- 個別詳細・返信・revision・intent回収・upload・download要求には `X-Feedback-Thread-Reference` headerを使用する。createと一覧には送信しない。query、URL、command DTOに埋め込まない。
- tokenは8192文字以下の `ftr1.kid.nonce.ciphertext.tag`、各segmentはpaddingなしcanonical base64url（kidは英数字、underscore、hyphen、1〜64文字）。clientは解読・組立て・provider判定をしない。
- 参照はrequestHash対象外。更新した参照で同一intentを回収してもhashは変更しない。返却されたtokenを更新するときもthreadIdは不変。
- 不正なheader形状は400。復号失敗、期限切れ、unknown kid、別scopeは非retryableの409 `feedback.integrity_error`。存在しない参照先は404、現在の認可拒否は403等の既存認可error。いずれもtokenを消して検索し直す自動retryは禁止。

## 信頼境界

- 参照は権限ではない。Authorization Mode、current grant／remote decision、profile policy、backend capability、participant所有者確認、attachment独立権限を従来どおり検査する。
- 暗号化はAES-256-GCM、random nonce 12 bytes、tag 16 bytes。AADに用途・形式version・kid・serviceId／origin／basePath・profileId・installationId・workspaceId・resource kind/key・threadIdを束縛する。
- payloadは必要最小限のprovider識別子／ticket識別子と発行・失効時刻だけ。本文、credential、participant、URLを含めない。復号後もproviderの現在のEnvelope署名、provider binding、threadとscopeを検証する。readのprojection検証は省略しない。
- 新規参照は発行から30日で失効。成功した直接取得／write／回収では新しい参照を返せる。downloadは更新tokenを返さず、個別詳細で更新できる。
- profileの任意 `secretRefs.threadReferenceKeyRing` から独立鍵を読む。secret既定値・自動生成・永続保存はない。activeは1鍵、verify-onlyを含め最大8鍵、鍵長は厳密に32 bytes。Envelope・participant credential・participant ID導出のsecret参照を流用しない。
- 通常rotationは旧鍵を最後の発行から30日保持する。緊急失効は旧鍵をringから外して全instanceへ反映する。DBレスの個別token失効は提供しない。認可取消しの反映上限は既存Authorization Mode規約から変わらない。
- tokenをaccess log・metric・error detailへ記録しない。reverse proxyでも該当headerをredactする。応答はno-store。

## 実装portとconsumer

- Connectorの任意 `supportsThreadReferences: true` は、検証済み直接参照を受けた全個別操作で検索fallbackしない宣言。未対応Connectorには参照を発行せず、参照付き要求は拒否する。
- server-only repository optionの直接参照を全provider操作へ伝播する。作成／回収／writeのEnvelope検証後に通知するserver-only callbackから発行するため、作成成功後に検索し直す必要はない。
- HTTP clientは共通headerを扱う。controllerはprofile／workspace／resource／thread単位の参照を端末内UX stateへ保存し、pending intentにも保持する。旧stateはそのまま読める。1000参照を上限とし、上限時はerrorにして黙って忘れない。
- 一覧refreshで既存の固定参照を上書きしない。同一一覧pageに複数の同じthreadIdが見えた場合は表示候補から除外する。別page／別時点に隠れた重複の完全検出は保証しない。
- React／Web Componentは同じcontrollerを使い、参照用独自state／provider分岐を追加しない。参照の再選択が必要な場合は自動復旧せず、運用者がprovider上の対象を確認する。
- Redmine v1のendpoint・DTO・browser storage keyは変更しない。v2 storageも既存keyを維持する。旧bundleは新参照stateを保持しないので、bundle downgrade時は直接参照による固定の継続を保証しない。
