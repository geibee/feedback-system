import { toBlob } from "html-to-image";
import type { FeedbackEvidenceProvider } from "@geibee/feedback-core";

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

type MaskRectangle = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type DecodedImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
  dispose(): void;
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
    const maskRectangles = collectMaskRectangles(root, request.maskSelector, viewportWidth, viewportHeight);
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
    if (maskRectangles.length > 0) {
      blob = await maskImage(ownerDocument, blob, maskRectangles, viewportWidth, viewportHeight);
    }
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
  };
}

function collectMaskRectangles(
  root: HTMLElement,
  selector: string,
  viewportWidth: number,
  viewportHeight: number
): MaskRectangle[] {
  if (!selector.trim()) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).flatMap((element) => {
    const bounds = element.getBoundingClientRect();
    const rectangle = {
      left: Math.max(0, bounds.left),
      top: Math.max(0, bounds.top),
      right: Math.min(viewportWidth, bounds.right),
      bottom: Math.min(viewportHeight, bounds.bottom)
    };
    return rectangle.right > rectangle.left && rectangle.bottom > rectangle.top ? [rectangle] : [];
  });
}

async function maskImage(
  ownerDocument: Document,
  blob: Blob,
  rectangles: MaskRectangle[],
  viewportWidth: number,
  viewportHeight: number
): Promise<Blob> {
  const image = await decodeImage(ownerDocument, blob);
  try {
    if (image.width <= 0 || image.height <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
      throw new Error("DOM証跡の画像寸法が不正です");
    }
    const canvas = ownerDocument.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("DOM証跡のマスク用canvasを初期化できません");

    context.drawImage(image.source, 0, 0);
    context.fillStyle = "#111";
    const scaleX = image.width / viewportWidth;
    const scaleY = image.height / viewportHeight;
    rectangles.forEach((rectangle) => {
      const left = Math.floor(rectangle.left * scaleX);
      const top = Math.floor(rectangle.top * scaleY);
      const right = Math.ceil(rectangle.right * scaleX);
      const bottom = Math.ceil(rectangle.bottom * scaleY);
      context.fillRect(left, top, right - left, bottom - top);
    });

    return await encodePng(canvas);
  } finally {
    image.dispose();
  }
}

async function decodeImage(ownerDocument: Document, blob: Blob): Promise<DecodedImage> {
  const view = ownerDocument.defaultView;
  if (view && typeof view.createImageBitmap === "function") {
    const bitmap = await view.createImageBitmap(blob);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      dispose: () => bitmap.close()
    };
  }

  if (!view || typeof view.URL.createObjectURL !== "function") {
    throw new Error("DOM証跡の画像をデコードできません");
  }
  const objectUrl = view.URL.createObjectURL(blob);
  const image = new view.Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("DOM証跡の画像をデコードできません"));
      image.src = objectUrl;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      dispose: () => view.URL.revokeObjectURL(objectUrl)
    };
  } catch (reason) {
    view.URL.revokeObjectURL(objectUrl);
    throw reason;
  }
}

function encodePng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error("DOM証跡のマスク済み画像を生成できません"));
    }, "image/png");
  });
}
