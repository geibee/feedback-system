import { toBlob } from "html-to-image";
import type { FeedbackEvidenceProvider } from "@feedback/core";

export type DomEvidenceProviderOptions = {
  root?: () => HTMLElement;
  maxPixelRatio?: number;
  maxBytes?: number;
  /** テストやhost固有renderer用。未指定時はhtml-to-imageを使う。 */
  render?: (root: HTMLElement, options: DomCaptureRenderOptions) => Promise<Blob | null>;
};

export type DomCaptureRenderOptions = {
  width: number;
  height: number;
  pixelRatio: number;
  style: Record<string, string>;
  filter(node: Node): boolean;
};

/** exclude/mask を尊重し、現在のviewportだけを取得する既定 DOM capture。 */
export function createDomEvidenceProvider(options: DomEvidenceProviderOptions = {}): FeedbackEvidenceProvider {
  return async (request) => {
    if (typeof document === "undefined") return null;
    const root = options.root?.() ?? document.body;
    const ownerDocument = root.ownerDocument;
    const view = ownerDocument.defaultView ?? window;
    const viewportWidth = ownerDocument.documentElement.clientWidth || view.innerWidth;
    const viewportHeight = ownerDocument.documentElement.clientHeight || view.innerHeight;
    const scrollX = Math.round(view.scrollX);
    const scrollY = Math.round(view.scrollY);
    const maskedElements = installMasks(root, request.maskSelector);
    try {
      const pixelRatio = Math.min(view.devicePixelRatio || 1, options.maxPixelRatio ?? 2);
      let blob: Blob | null;
      try {
        blob = await (options.render ?? toBlob)(root, {
          width: viewportWidth,
          height: viewportHeight,
          pixelRatio,
          style: {
            transform: `translate(${-scrollX}px, ${-scrollY}px)`,
            transformOrigin: "top left"
          },
          filter: (node) => !(node instanceof Element) || !node.matches(request.excludeSelector)
        });
      } catch (reason) {
        if (!(reason instanceof Error)) {
          throw new Error("DOM証跡の画像化に失敗しました。Content-Security-Policyのimg-srcでdata:画像が許可されているか確認してください");
        }
        throw reason;
      }
      if (!blob) return null;
      if (blob.size > (options.maxBytes ?? Number.MAX_SAFE_INTEGER)) {
        throw new Error("取得した証跡が許可サイズを超えています");
      }
      return {
        bytes: new Uint8Array(await blob.arrayBuffer()),
        contentType: "image/png",
        viewportWidth,
        viewportHeight,
        pixelRatio,
        capturedAt: new Date().toISOString()
      };
    } finally {
      maskedElements.forEach((element) => element.classList.remove("feedback-mask-active"));
    }
  };
}

function installMasks(root: HTMLElement, selector: string): HTMLElement[] {
  if (!selector.trim()) return [];
  const elements = Array.from(root.querySelectorAll<HTMLElement>(selector));
  elements.forEach((element) => element.classList.add("feedback-mask-active"));
  return elements;
}
