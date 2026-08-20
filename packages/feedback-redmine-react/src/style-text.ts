export { redmineFeedbackStyles } from "./style-text.generated.js";
import { redmineFeedbackStyles } from "./style-text.generated.js";

/** hostのinline-style CSPへ依存せずShadow DOMへ正本styleを適用する。 */
export function installRedmineFeedbackStyles(shadow: ShadowRoot): () => void {
  if (typeof CSSStyleSheet !== "undefined" && "replaceSync" in CSSStyleSheet.prototype && "adoptedStyleSheets" in shadow) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(redmineFeedbackStyles);
    shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
    return () => {
      shadow.adoptedStyleSheets = shadow.adoptedStyleSheets.filter((candidate) => candidate !== sheet);
    };
  }
  const style = document.createElement("style");
  style.textContent = redmineFeedbackStyles;
  shadow.append(style);
  return () => style.remove();
}
