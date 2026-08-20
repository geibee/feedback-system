import { describe, expect, it } from "vitest";
import { createDomEvidenceProvider } from "./index";

describe("DOM evidence provider", () => {
  it("maskを一時適用しexcludeをcapture対象から外す", async () => {
    const root = document.createElement("main");
    const masked = document.createElement("p");
    masked.setAttribute("data-feedback-mask", "");
    const excluded = document.createElement("aside");
    excluded.setAttribute("data-feedback-exclude", "");
    root.append(masked, excluded);
    document.body.appendChild(root);
    let resolveBlob: ((value: Blob) => void) | undefined;
    const render = async (_root: HTMLElement, options: DomCaptureRenderOptionsForTest) => {
      expect(options.filter(excluded)).toBe(false);
      expect(options.width).toBeGreaterThanOrEqual(0);
      expect(options.height).toBeGreaterThanOrEqual(0);
      expect(options.style).toMatchObject({ transformOrigin: "top left" });
      return await new Promise<Blob>((resolve) => { resolveBlob = resolve; });
    };

    const capture = createDomEvidenceProvider({ root: () => root, maxBytes: 10, render });
    const pending = capture(evidenceRequest());
    expect(masked.classList.contains("feedback-mask-active")).toBe(true);
    resolveBlob?.(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
    const evidence = await pending;

    expect(evidence?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(masked.classList.contains("feedback-mask-active")).toBe(false);
    root.remove();
  });

  it("取得上限超過やrenderer失敗でもmaskを解除する", async () => {
    const root = document.createElement("main");
    const masked = document.createElement("p");
    masked.setAttribute("data-feedback-mask", "");
    root.appendChild(masked);

    const capture = createDomEvidenceProvider({
      root: () => root,
      maxBytes: 1,
      render: async () => new Blob([new Uint8Array([1, 2])], { type: "image/png" })
    });

    await expect(capture(evidenceRequest())).rejects.toThrow("許可サイズを超えています");
    expect(masked.classList.contains("feedback-mask-active")).toBe(false);
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

type DomCaptureRenderOptionsForTest = {
  width: number;
  height: number;
  style: Record<string, string>;
  filter(node: Node): boolean;
};

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
