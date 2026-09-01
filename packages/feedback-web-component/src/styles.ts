/** Shadow DOM内だけへ適用する。url、@import、外部fontは使用しない。 */
export const feedbackWebComponentStyles = `
:host{position:fixed;right:1rem;bottom:1rem;z-index:2147483000;font:14px/1.5 system-ui,sans-serif;color:#172033;color-scheme:light}
*,*::before,*::after{box-sizing:border-box}
button,select,textarea{font:inherit}
.launcher,.button{border:1px solid #334155;border-radius:.5rem;background:#0f172a;color:#fff;padding:.55rem .8rem;cursor:pointer}
.button:disabled{cursor:not-allowed;opacity:.55}
.panel{position:absolute;right:0;bottom:3.25rem;width:min(92vw,26rem);max-height:min(78vh,44rem);overflow:auto;border:1px solid #cbd5e1;border-radius:.75rem;background:#fff;color:#172033;box-shadow:0 18px 48px #0f172a33;padding:1rem}
.header{display:flex;align-items:center;justify-content:space-between;gap:.75rem}.header h2{font-size:1rem;margin:0}
.actions{display:flex;flex-wrap:wrap;gap:.5rem;margin:.75rem 0}.list{display:grid;gap:.5rem;list-style:none;margin:.75rem 0;padding:0}
.thread{width:100%;border:1px solid #cbd5e1;border-radius:.5rem;background:#f8fafc;color:#172033;padding:.6rem;text-align:left;cursor:pointer}.thread[aria-current=true]{border-color:#2563eb;background:#eff6ff}
.unread{display:inline-block;min-width:1.4rem;margin-left:.4rem;border-radius:999px;background:#b91c1c;color:#fff;padding:0 .35rem;text-align:center}
.field{display:grid;gap:.25rem;margin:.75rem 0}.field select,.field textarea{width:100%;border:1px solid #94a3b8;border-radius:.4rem;background:#fff;color:#172033;padding:.5rem}
.messages{display:grid;gap:.5rem;margin:.75rem 0}.message{border-left:3px solid #94a3b8;padding-left:.6rem;white-space:pre-wrap}.message p{margin:.25rem 0}
.problem{border:1px solid #ef4444;border-radius:.4rem;background:#fef2f2;color:#991b1b;padding:.6rem}.status{min-height:1.5rem;color:#475569}
@media (max-width:36rem){:host{right:.5rem;bottom:.5rem}.panel{position:fixed;inset:.5rem;width:auto;max-height:none}}
`;
