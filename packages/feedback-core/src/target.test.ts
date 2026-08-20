import { describe, expect, it } from "vitest";
import { parseFeedbackTarget } from "./target";

describe("FeedbackTargetV1", () => {
  it("5 variantを厳密に検証する", () => {
    expect(parseFeedbackTarget({
      schemaVersion: "1",
      kind: "ui-element",
      elementKey: "save",
      relativeX: 0.5,
      relativeY: 1
    })?.kind).toBe("ui-element");
    expect(parseFeedbackTarget({
      schemaVersion: "1",
      kind: "screen-position",
      relativeX: 0,
      relativeY: 0.25
    })?.kind).toBe("screen-position");
    expect(parseFeedbackTarget({
      schemaVersion: "1",
      kind: "map-feature",
      provider: "maplibre",
      sourceKey: "parcels",
      featureKey: "P-1",
      longitude: 139.7,
      latitude: 35.6
    })?.kind).toBe("map-feature");
    expect(parseFeedbackTarget({
      schemaVersion: "1",
      kind: "map-position",
      longitude: 139.7,
      latitude: 35.6
    })?.kind).toBe("map-position");
    expect(parseFeedbackTarget({
      schemaVersion: "1",
      kind: "custom",
      provider: "com.example.threejs",
      targetKey: "model-42",
      fallbackRelativeX: 0.25,
      fallbackRelativeY: 0.75,
      metadata: { layerName: "equipment", level: 3, selected: true, parentId: null }
    })).toEqual({
      schemaVersion: "1",
      kind: "custom",
      provider: "com.example.threejs",
      targetKey: "model-42",
      fallbackRelativeX: 0.25,
      fallbackRelativeY: 0.75,
      metadata: { layerName: "equipment", level: 3, selected: true, parentId: null }
    });
  });

  it("範囲外座標と未知fieldを拒否する", () => {
    expect(parseFeedbackTarget({
      schemaVersion: "1",
      kind: "screen-position",
      relativeX: 1.1,
      relativeY: 0
    })).toBeNull();
    expect(parseFeedbackTarget({
      schemaVersion: "1",
      kind: "map-position",
      longitude: 181,
      latitude: 0
    })).toBeNull();
    expect(parseFeedbackTarget({
      schemaVersion: "1",
      kind: "screen-position",
      relativeX: 0.5,
      relativeY: 0.5,
      secret: "unexpected"
    })).toBeNull();
  });

  it("custom targetの識別子、fallback、metadataをfail-closedで検証する", () => {
    const custom = {
      schemaVersion: "1",
      kind: "custom",
      provider: "com.example.canvas",
      targetKey: "shape-1",
      fallbackRelativeX: 0,
      fallbackRelativeY: 1
    };
    expect(parseFeedbackTarget(custom)?.kind).toBe("custom");
    expect(parseFeedbackTarget({ ...custom, provider: "Invalid Provider" })).toBeNull();
    expect(parseFeedbackTarget({ ...custom, targetKey: "" })).toBeNull();
    expect(parseFeedbackTarget({ ...custom, fallbackRelativeY: Number.NaN })).toBeNull();
    expect(parseFeedbackTarget({ ...custom, metadata: { "_invalid": true } })).toBeNull();
    expect(parseFeedbackTarget({ ...custom, metadata: { value: { nested: true } } })).toBeNull();
    expect(parseFeedbackTarget({ ...custom, metadata: { value: ["array"] } })).toBeNull();
    expect(parseFeedbackTarget({ ...custom, metadata: { value: "x".repeat(501) } })).toBeNull();
    expect(parseFeedbackTarget({
      ...custom,
      metadata: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`key${index}`, index]))
    })).toBeNull();
    expect(parseFeedbackTarget({ ...custom, unknown: true })).toBeNull();
  });
});
