import { describe, expect, it, vi } from "vitest";
import type { FeedbackEvidencePayload } from "@geibee/core";
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
});
