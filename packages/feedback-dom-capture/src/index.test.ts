import { afterEach, describe, expect, it, vi } from "vitest";
import { createDomEvidenceProvider } from "./index";

const originalCreateImageBitmap = Object.getOwnPropertyDescriptor(window, "createImageBitmap");
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(window.URL, "createObjectURL");
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(window.URL, "revokeObjectURL");

describe("DOM evidence provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    restoreProperty(window, "createImageBitmap", originalCreateImageBitmap);
    restoreProperty(window.URL, "createObjectURL", originalCreateObjectURL);
    restoreProperty(window.URL, "revokeObjectURL", originalRevokeObjectURL);
    document.body.replaceChildren();
  });

  it("excludeを画像化対象から外し、maskがなければ元画像を返す", async () => {
    const root = document.createElement("main");
    const excluded = document.createElement("aside");
    excluded.setAttribute("data-feedback-exclude", "");
    root.appendChild(excluded);
    document.body.appendChild(root);
    const rendered = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const render = vi.fn(async (_root: HTMLElement, options: DomCaptureRenderOptionsForTest) => {
      expect(options.filter(excluded)).toBe(false);
      expect(options.width).toBeGreaterThan(0);
      expect(options.height).toBeGreaterThan(0);
      expect(options.style).toMatchObject({ transformOrigin: "top left" });
      return rendered;
    });

    const capture = createDomEvidenceProvider({ root: () => root, maxBytes: 3, render });
    const evidence = await capture(evidenceRequest());

    expect(evidence?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(render).toHaveBeenCalledOnce();
    root.remove();
  });

  it("viewport内へclipしたmask矩形を実画像寸法へ拡大して黒塗りする", async () => {
    const root = document.createElement("main");
    const masked = document.createElement("p");
    masked.setAttribute("data-feedback-mask", "");
    root.appendChild(masked);
    document.body.appendChild(root);
    vi.spyOn(masked, "getBoundingClientRect").mockReturnValue(domRect(-10, 50, 120, 150));

    const rendered = new Blob([new Uint8Array(20)], { type: "image/png" });
    const maskedBlob = new Blob([new Uint8Array([7, 8])], { type: "image/png" });
    const bitmap = { width: 2048, height: 1536, close: vi.fn() } as unknown as ImageBitmap;
    const createImageBitmap = vi.fn(async () => bitmap);
    Object.defineProperty(window, "createImageBitmap", { configurable: true, value: createImageBitmap });
    const drawImage = vi.fn();
    const fillRect = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
      fillRect,
      fillStyle: ""
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(maskedBlob));

    const capture = createDomEvidenceProvider({
      root: () => root,
      maxBytes: 2,
      render: async () => rendered
    });
    const evidence = await capture(evidenceRequest());

    expect(createImageBitmap).toHaveBeenCalledWith(rendered);
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
    expect(fillRect).toHaveBeenCalledWith(0, 100, 220, 300);
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(evidence?.bytes).toEqual(new Uint8Array([7, 8]));
    root.remove();
  });

  it("createImageBitmapがないbrowserではBlob URLとHTMLImageElementを使う", async () => {
    const root = document.createElement("main");
    const masked = document.createElement("p");
    masked.setAttribute("data-feedback-mask", "");
    root.appendChild(masked);
    document.body.appendChild(root);
    vi.spyOn(masked, "getBoundingClientRect").mockReturnValue(domRect(10, 20, 30, 40));
    Object.defineProperty(window, "createImageBitmap", { configurable: true, value: undefined });

    const createObjectURL = vi.fn(() => "blob:masked-source");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(window.URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(window.URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const originalImage = Object.getOwnPropertyDescriptor(window, "Image");
    Object.defineProperty(window, "Image", { configurable: true, value: SuccessfulImage });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: ""
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(new Blob([new Uint8Array([9])], { type: "image/png" }));
    });

    try {
      const capture = createDomEvidenceProvider({ root: () => root, render: async () => new Blob(["source"]) });
      const evidence = await capture(evidenceRequest());

      expect(evidence?.bytes).toEqual(new Uint8Array([9]));
      expect(createObjectURL).toHaveBeenCalledOnce();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:masked-source");
    } finally {
      if (originalImage) Object.defineProperty(window, "Image", originalImage);
      root.remove();
    }
  });

  it("mask画像をデコードできない場合は未加工画像を返さない", async () => {
    const root = document.createElement("main");
    const masked = document.createElement("p");
    masked.setAttribute("data-feedback-mask", "");
    root.appendChild(masked);
    vi.spyOn(masked, "getBoundingClientRect").mockReturnValue(domRect(10, 10, 20, 20));
    Object.defineProperty(window, "createImageBitmap", {
      configurable: true,
      value: vi.fn(async () => { throw new Error("decode failed"); })
    });
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob");

    const capture = createDomEvidenceProvider({ root: () => root, render: async () => new Blob(["secret"]) });

    await expect(capture(evidenceRequest())).rejects.toThrow("decode failed");
    expect(toBlob).not.toHaveBeenCalled();
  });

  it("mask用canvasを初期化できない場合は未加工画像を返さない", async () => {
    const { root } = prepareMaskFixture();
    Object.defineProperty(window, "createImageBitmap", {
      configurable: true,
      value: vi.fn(async () => ({ width: 100, height: 100, close: vi.fn() }))
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob");
    const capture = createDomEvidenceProvider({ root: () => root, render: async () => new Blob(["secret"]) });

    await expect(capture(evidenceRequest())).rejects.toThrow("canvasを初期化できません");
    expect(toBlob).not.toHaveBeenCalled();
    root.remove();
  });

  it("mask済みPNGを生成できない場合は未加工画像を返さない", async () => {
    const { root } = prepareMaskFixture();
    Object.defineProperty(window, "createImageBitmap", {
      configurable: true,
      value: vi.fn(async () => ({ width: 100, height: 100, close: vi.fn() }))
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: ""
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(null));
    const capture = createDomEvidenceProvider({ root: () => root, render: async () => new Blob(["secret"]) });

    await expect(capture(evidenceRequest())).rejects.toThrow("マスク済み画像を生成できません");
    root.remove();
  });

  it("mask済み画像へ容量上限を適用する", async () => {
    const root = document.createElement("main");
    const masked = document.createElement("p");
    masked.setAttribute("data-feedback-mask", "");
    root.appendChild(masked);
    vi.spyOn(masked, "getBoundingClientRect").mockReturnValue(domRect(10, 10, 20, 20));
    Object.defineProperty(window, "createImageBitmap", {
      configurable: true,
      value: vi.fn(async () => ({ width: 100, height: 100, close: vi.fn() }))
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: ""
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(new Blob([new Uint8Array([1, 2])], { type: "image/png" }));
    });
    const capture = createDomEvidenceProvider({
      root: () => root,
      maxBytes: 1,
      render: async () => new Blob([new Uint8Array([1])], { type: "image/png" })
    });

    await expect(capture(evidenceRequest())).rejects.toThrow("許可サイズを超えています");
  });

  it("browserの画像読込eventで失敗した場合にCSPの確認方法を示す", async () => {
    const root = document.createElement("main");
    document.body.appendChild(root);
    const capture = createDomEvidenceProvider({
      root: () => root,
      render: async () => { throw new Event("error"); }
    });

    await expect(capture(evidenceRequest())).rejects.toThrow("img-srcでdata:画像が許可されているか");
    root.remove();
  });
});

class SuccessfulImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 100;
  naturalHeight = 50;

  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

type DomCaptureRenderOptionsForTest = {
  width: number;
  height: number;
  style: Record<string, string>;
  filter(node: Node): boolean;
};

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({})
  };
}

function prepareMaskFixture(): { root: HTMLElement; masked: HTMLElement } {
  const root = document.createElement("main");
  const masked = document.createElement("p");
  masked.setAttribute("data-feedback-mask", "");
  root.appendChild(masked);
  document.body.appendChild(root);
  vi.spyOn(masked, "getBoundingClientRect").mockReturnValue(domRect(10, 10, 20, 20));
  return { root, masked };
}

function restoreProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
  } else {
    Reflect.deleteProperty(target, key);
  }
}

function evidenceRequest() {
  return {
    context: {
      schemaVersion: "1" as const,
      applicationKey: "consumer",
      environmentKey: "test",
      externalWorkspaceKey: "workspace-1",
      release: "test"
    },
    location: { schemaVersion: "1" as const, pageKey: "orders", routeTemplate: "/orders", pathParameters: {} },
    target: { schemaVersion: "1" as const, kind: "screen-position" as const, relativeX: 0.5, relativeY: 0.5 },
    excludeSelector: "[data-feedback-exclude]",
    maskSelector: "[data-feedback-mask]"
  };
}
