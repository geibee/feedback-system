import { describe, expect, it } from "vitest";
import { parseCreateRequest } from "./validation.js";

const customTarget = {
  schemaVersion: "1",
  kind: "custom",
  provider: "com.example.threejs",
  targetKey: "model-42",
  fallbackRelativeX: 0.25,
  fallbackRelativeY: 0.75,
  metadata: { layerName: "equipment", level: 3, selected: true, parentId: null }
};

function createRequest(target: unknown = customTarget): Record<string, unknown> {
  return {
    resourceRef: { schemaVersion: "1", kind: "record", key: "order-1" },
    threadId: "00000000-0000-4000-8000-000000000001",
    intentId: "00000000-0000-4000-8000-000000000002",
    comment: "comment",
    perspectiveCode: "ux",
    location: {
      schemaVersion: "1",
      pageKey: "orders.detail",
      routeTemplate: "/orders/{orderId}",
      pathParameters: { orderId: "sha256:value" }
    },
    target,
    release: "2026.08.21",
    locale: "ja-JP",
    capturedAt: "2026-08-21T00:00:00Z",
    evidence: null
  };
}

describe("Redmine gateway custom target validation", () => {
  it("custom targetを制約どおりcreate inputへ写像する", () => {
    expect(parseCreateRequest(
      createRequest(),
      "inventory-production",
      "https://app.example"
    ).target).toEqual(customTarget);
  });

  it.each([
    { ...customTarget, provider: "Invalid Provider" },
    { ...customTarget, targetKey: "" },
    { ...customTarget, fallbackRelativeX: -0.1 },
    { ...customTarget, metadata: { "_invalid": true } },
    { ...customTarget, metadata: { nested: { value: true } } },
    { ...customTarget, metadata: { array: [1] } },
    { ...customTarget, metadata: { value: "x".repeat(501) } },
    {
      ...customTarget,
      metadata: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`key${index}`, index]))
    },
    { ...customTarget, unknown: true }
  ])("不正なcustom targetを拒否する", (target) => {
    expect(() => parseCreateRequest(
      createRequest(target),
      "inventory-production",
      "https://app.example"
    )).toThrow();
  });
});
