import { describe, expect, it } from "vitest";
import { resolveDomFeedbackTarget } from "./index.js";

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
});
