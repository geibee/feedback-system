import { describe, expect, it, vi } from "vitest";
import type { FeedbackEvidencePayload } from "@geibee/feedback-core";
import { feedbackDomPositionProvider } from "@geibee/feedback-react-ui";
import { addFeedbackCaptureMarker } from "./capture-marker.js";
import { resolveFeedbackPinPosition } from "./thread-pins.js";

const payload: FeedbackEvidencePayload = {
  bytes: new Uint8Array([1, 2, 3]),
  contentType: "image/png",
  viewportWidth: 100,
  viewportHeight: 80,
  pixelRatio: 1,
  capturedAt: "2026-08-20T00:00:00Z"
};

describe("スクリーンショットのFeedback位置", () => {
  it("画像rendererへ選択座標を渡し、焼き込み後のbytesだけを置換する", async () => {
    const render = vi.fn(async () => new Uint8Array([9, 8, 7, 6]));
    const result = await addFeedbackCaptureMarker(payload, { x: 30, y: 40 }, render);
    expect(render).toHaveBeenCalledWith(payload, { x: 30, y: 40 });
    expect(result).toEqual({ ...payload, bytes: new Uint8Array([9, 8, 7, 6]) });
  });

  it("screen位置をviewportへ投影し、host providerを優先する", () => {
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1000 });
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 800 });
    const target = { schemaVersion: "1", kind: "screen-position", relativeX: 0.25, relativeY: 0.5 } as const;
    expect(resolveFeedbackPinPosition(target)).toEqual({ x: 250, y: 400 });
    expect(resolveFeedbackPinPosition(target, {
      getPosition: () => ({ x: 10, y: 20 }),
      subscribe: () => () => undefined
    })).toEqual({ x: 10, y: 20 });
  });

  it("custom targetはhost providerで追従し、未解決時はfallback位置へ投影する", () => {
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1000 });
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 800 });
    const target = {
      schemaVersion: "1",
      kind: "custom",
      provider: "com.example.threejs",
      targetKey: "model-42",
      fallbackRelativeX: 0.25,
      fallbackRelativeY: 0.5
    } as const;
    expect(resolveFeedbackPinPosition(target, {
      getPosition: () => ({ x: 15, y: 25 }),
      subscribe: () => () => undefined
    })).toEqual({ x: 15, y: 25 });
    expect(resolveFeedbackPinPosition(target, {
      getPosition: () => null,
      subscribe: () => () => undefined
    })).toEqual({ x: 250, y: 400 });
    expect(resolveFeedbackPinPosition(target)).toEqual({ x: 250, y: 400 });
  });

  it("custom metadataのdocument位置をpage scrollに追従させる", () => {
    Object.defineProperty(window, "scrollX", { configurable: true, value: 40 });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 700 });
    expect(resolveFeedbackPinPosition({
      schemaVersion: "1",
      kind: "custom",
      provider: feedbackDomPositionProvider,
      targetKey: "document",
      fallbackRelativeX: 0.1,
      fallbackRelativeY: 0.1,
      metadata: { coordinateSpace: "document", documentX: 260, documentY: 900 }
    })).toEqual({ x: 220, y: 200 });
  });

  it("名前付きscroll領域の移動へ追従し、表示領域外ではpinを隠す", () => {
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1000 });
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 800 });
    const container = document.createElement("div");
    container.setAttribute("data-feedback-scroll-key", "orders.table");
    Object.defineProperties(container, {
      clientLeft: { configurable: true, value: 2 },
      clientTop: { configurable: true, value: 2 },
      clientWidth: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 300 },
      scrollLeft: { configurable: true, value: 300 },
      scrollTop: { configurable: true, value: 600 }
    });
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      x: 100, y: 50, left: 100, top: 50, right: 504, bottom: 354, width: 404, height: 304,
      toJSON: () => ({})
    });
    document.body.append(container);
    const target = {
      schemaVersion: "1",
      kind: "custom",
      provider: feedbackDomPositionProvider,
      targetKey: "orders.table",
      fallbackRelativeX: 0.25,
      fallbackRelativeY: 0.2,
      metadata: { coordinateSpace: "scroll-container", contentX: 448, contentY: 718 }
    } as const;
    expect(resolveFeedbackPinPosition(target)).toEqual({ x: 250, y: 170 });
    Object.defineProperty(container, "scrollTop", { configurable: true, value: 1000 });
    expect(resolveFeedbackPinPosition(target)).toBeNull();
    container.remove();
  });

  it("未知のDOM metadataは旧viewport fallbackへ安全に戻す", () => {
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1000 });
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 800 });
    expect(resolveFeedbackPinPosition({
      schemaVersion: "1",
      kind: "custom",
      provider: feedbackDomPositionProvider,
      targetKey: "document",
      fallbackRelativeX: 0.1,
      fallbackRelativeY: 0.25,
      metadata: { coordinateSpace: "document", documentX: "invalid", documentY: 220 }
    })).toEqual({ x: 100, y: 200 });
  });
});
