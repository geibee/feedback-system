import { describe, expect, it, vi } from "vitest";
import { createDomEvidenceProvider as createSharedDomEvidenceProvider } from "@geibee/feedback-dom-capture";
import { createDomEvidenceProvider } from "./capture";

describe("DOM evidence provider", () => {
  it("共有packageの実装を後方互換のため再exportする", () => {
    expect(createDomEvidenceProvider).toBe(createSharedDomEvidenceProvider);
  });

  it("mask処理に失敗した場合は未加工画像を返さない", async () => {
    const root = document.createElement("main");
    const masked = document.createElement("p");
    masked.setAttribute("data-feedback-mask", "");
    root.appendChild(masked);
    document.body.appendChild(root);
    vi.spyOn(masked, "getBoundingClientRect").mockReturnValue({
      x: 10,
      y: 10,
      left: 10,
      top: 10,
      right: 30,
      bottom: 30,
      width: 20,
      height: 20,
      toJSON: () => ({})
    });
    const original = Object.getOwnPropertyDescriptor(window, "createImageBitmap");
    Object.defineProperty(window, "createImageBitmap", {
      configurable: true,
      value: vi.fn(async () => { throw new Error("mask decode failed"); })
    });

    try {
      const capture = createDomEvidenceProvider({ root: () => root, render: async () => new Blob(["secret"]) });
      await expect(capture({
        context: {
          schemaVersion: "1",
          applicationKey: "consumer",
          environmentKey: "test",
          externalWorkspaceKey: "workspace-1",
          release: "test"
        },
        location: { schemaVersion: "1", pageKey: "orders", routeTemplate: "/orders", pathParameters: {} },
        target: { schemaVersion: "1", kind: "screen-position", relativeX: 0.5, relativeY: 0.5 },
        excludeSelector: "[data-feedback-exclude]",
        maskSelector: "[data-feedback-mask]"
      })).rejects.toThrow("mask decode failed");
    } finally {
      if (original) Object.defineProperty(window, "createImageBitmap", original);
      else Reflect.deleteProperty(window, "createImageBitmap");
      root.remove();
    }
  });
});
