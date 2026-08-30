import { describe, expect, it } from "vitest";
import { feedbackDomPositionProvider, resolveDomFeedbackTarget } from "./index.js";

describe("resolveDomFeedbackTarget", () => {
  it("レイアウト未計算でもdata-feedback-keyを画面座標へ降格しない", () => {
    const keyed = {
      getAttribute: () => "orders.save",
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 0,
        height: 0
      })
    } as unknown as HTMLElement;
    const element = {
      closest: () => keyed
    } as unknown as Element;

    expect(resolveDomFeedbackTarget({ element, clientX: 160, clientY: 120 })).toMatchObject({
      kind: "ui-element",
      elementKey: "orders.save"
    });
  });

  it("keyのない位置はdocument座標として保存する", () => {
    const element = { closest: () => null } as unknown as Element;
    expect(resolveDomFeedbackTarget({
      element,
      clientX: 160,
      clientY: 120,
      scrollX: 30,
      scrollY: 800,
      viewportWidth: 1000,
      viewportHeight: 800
    })).toEqual({
      schemaVersion: "1",
      kind: "custom",
      provider: feedbackDomPositionProvider,
      targetKey: "document",
      fallbackRelativeX: 0.16,
      fallbackRelativeY: 0.15,
      metadata: {
        coordinateSpace: "document",
        documentX: 190,
        documentY: 920
      }
    });
  });

  it("名前付きscroll領域はcontent座標として保存する", () => {
    const container = {
      getAttribute: () => "orders.table",
      getBoundingClientRect: () => ({ left: 100, top: 50 }),
      clientLeft: 2,
      clientTop: 2,
      scrollLeft: 300,
      scrollTop: 600
    } as unknown as HTMLElement;
    const element = {
      closest: (selector: string) => selector === "[data-feedback-scroll-key]" ? container : null
    } as unknown as Element;
    expect(resolveDomFeedbackTarget({
      element,
      clientX: 250,
      clientY: 170,
      viewportWidth: 1000,
      viewportHeight: 1000
    })).toEqual({
      schemaVersion: "1",
      kind: "custom",
      provider: feedbackDomPositionProvider,
      targetKey: "orders.table",
      fallbackRelativeX: 0.25,
      fallbackRelativeY: 0.17,
      metadata: {
        coordinateSpace: "scroll-container",
        contentX: 448,
        contentY: 718
      }
    });
  });
});
