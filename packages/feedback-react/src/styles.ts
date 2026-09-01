export const feedbackReactStyles = `
.feedback-v2-root{position:fixed;right:1rem;bottom:1rem;z-index:2147483000;font:14px/1.5 system-ui,sans-serif;color:#172033}
.feedback-v2-root *{box-sizing:border-box}
.feedback-v2-launcher,.feedback-v2-button{border:1px solid #334155;border-radius:.5rem;background:#0f172a;color:#fff;padding:.55rem .8rem;cursor:pointer}
.feedback-v2-button[disabled]{cursor:not-allowed;opacity:.55}
.feedback-v2-panel{position:absolute;right:0;bottom:3.25rem;width:min(92vw,26rem);max-height:min(78vh,44rem);overflow:auto;border:1px solid #cbd5e1;border-radius:.75rem;background:#fff;color:#172033;box-shadow:0 18px 48px #0f172a33;padding:1rem}
.feedback-v2-header{display:flex;align-items:center;justify-content:space-between;gap:.75rem}
.feedback-v2-header h2{font-size:1rem;margin:0}
.feedback-v2-actions{display:flex;flex-wrap:wrap;gap:.5rem;margin:.75rem 0}
.feedback-v2-list{display:grid;gap:.5rem;list-style:none;margin:.75rem 0;padding:0}
.feedback-v2-thread{width:100%;border:1px solid #cbd5e1;border-radius:.5rem;background:#f8fafc;color:#172033;padding:.6rem;text-align:left;cursor:pointer}
.feedback-v2-thread[aria-current=true]{border-color:#2563eb;background:#eff6ff}
.feedback-v2-unread{display:inline-block;min-width:1.4rem;margin-left:.4rem;border-radius:999px;background:#b91c1c;color:#fff;padding:0 .35rem;text-align:center}
.feedback-v2-field{display:grid;gap:.25rem;margin:.75rem 0}
.feedback-v2-field select,.feedback-v2-field textarea{width:100%;border:1px solid #94a3b8;border-radius:.4rem;background:#fff;color:#172033;padding:.5rem}
.feedback-v2-messages{display:grid;gap:.5rem;margin:.75rem 0}
.feedback-v2-message{border-left:3px solid #94a3b8;padding-left:.6rem;white-space:pre-wrap}
.feedback-v2-problem{border:1px solid #ef4444;border-radius:.4rem;background:#fef2f2;color:#991b1b;padding:.6rem}
.feedback-v2-status{min-height:1.5rem;color:#475569}
@media (max-width:36rem){.feedback-v2-root{right:.5rem;bottom:.5rem}.feedback-v2-panel{position:fixed;inset:.5rem;width:auto;max-height:none}}
`;

/** React rendererのCSSをDocumentまたは既存Shadow Rootへ明示的に導入する。 */
export function installFeedbackReactStyles(root: Document | ShadowRoot, nonce?: string): () => void {
  const document = root.nodeType === 9 ? root as Document : root.ownerDocument;
  if (!document) throw new Error("style導入先のDocumentを取得できません");
  const style = document.createElement("style");
  style.dataset.feedbackV2ReactStyles = "true";
  if (nonce) style.nonce = nonce;
  style.textContent = feedbackReactStyles;
  const container = root.nodeType === 9 ? document.head ?? document.documentElement : root;
  container.append(style);
  return () => style.remove();
}
