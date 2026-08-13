// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindMapLibreFeedbackPins,
  captureReadyCanvasContextAttributes,
  createMapLibreEvidenceProvider,
  findUnreadableMapCanvases,
  resolveMapLibreFeedbackTarget,
  resolveMapLibreFeedbackTargetAtClientPoint
} from "./index";

const event = {
  point: { x: 10, y: 20 },
  lngLat: { lng: 139.7, lat: 35.6 }
} as never;

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("MapLibre target adapter", () => {
  it("hostが変換した安定source/feature keyを利用する", () => {
    const feature = {
      source: "runtime-source",
      sourceLayer: "parcel",
      id: 42,
      properties: { parcelId: "P-42" }
    };
    const map = { queryRenderedFeatures: () => [feature] } as never;
    expect(resolveMapLibreFeedbackTarget(map, event, {
      toSourceKey: () => "parcels",
      toFeatureKey: (candidate) => String(candidate.properties?.parcelId)
    })).toEqual({
      schemaVersion: "1",
      kind: "map-feature",
      provider: "maplibre",
      sourceKey: "parcels",
      sourceLayer: "parcel",
      featureKey: "P-42",
      longitude: 139.7,
      latitude: 35.6
    });
  });

  it("変換不能なfeatureは位置targetへ下げる", () => {
    const map = {
      queryRenderedFeatures: () => [{ source: "runtime", id: 42, properties: {} }]
    } as never;
    expect(resolveMapLibreFeedbackTarget(map, event, {
      toSourceKey: () => null,
      toFeatureKey: () => null
    }).kind).toBe("map-position");
  });

  it("browserのclient座標をcanvas座標と経緯度へ変換する", () => {
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 100, y: 50, left: 100, top: 50, right: 900, bottom: 650, width: 800, height: 600,
      toJSON: () => ({})
    });
    const map = {
      getCanvas: () => canvas,
      unproject: vi.fn(() => ({ lng: 139.7, lat: 35.6 })),
      queryRenderedFeatures: vi.fn(() => [])
    };

    expect(resolveMapLibreFeedbackTargetAtClientPoint(map, { clientX: 260, clientY: 170 }, {
      toSourceKey: () => null,
      toFeatureKey: () => null
    })).toEqual({
      schemaVersion: "1",
      kind: "map-position",
      longitude: 139.7,
      latitude: 35.6
    });
    expect(map.unproject).toHaveBeenCalledWith([160, 120]);
    expect(map.queryRenderedFeatures).toHaveBeenCalledWith([160, 120], undefined);
  });

  it("style reloadでmarkerを再構築しlayer消滅とmap unloadでcleanupする", () => {
    const listeners = new Map<string, () => void>();
    let layerExists = true;
    const map = {
      on: (event: string, listener: () => void) => listeners.set(event, listener),
      off: (event: string) => listeners.delete(event),
      getLayer: () => (layerExists ? {} : undefined)
    };
    const removed: number[] = [];
    const createMarker = vi.fn(() => ({ remove: () => removed.push(1) }));
    const binding = bindMapLibreFeedbackPins(map, { requiredLayerIds: ["feedback"], createMarker });
    const thread = {
      target: { schemaVersion: "1", kind: "map-position", longitude: 139.7, latitude: 35.6 }
    } as never;
    binding.update([thread]);
    expect(createMarker).toHaveBeenCalledTimes(1);

    listeners.get("styledata")?.();
    expect(createMarker).toHaveBeenCalledTimes(2);
    expect(removed).toHaveLength(1);

    layerExists = false;
    listeners.get("styledata")?.();
    expect(removed).toHaveLength(2);
    listeners.get("remove")?.();
    expect(listeners.size).toBe(0);
  });

  it("render event内でWebGL描画を固定し、MapLibre controlsと共にDOM証跡へ渡す", async () => {
    const container = document.createElement("div");
    const canvas = document.createElement("canvas");
    canvas.className = "maplibregl-canvas";
    canvas.width = 800;
    canvas.height = 600;
    const control = document.createElement("button");
    control.className = "maplibregl-ctrl-zoom-in";
    container.append(canvas, control);
    document.body.append(container);

    const snapshot = document.createElement("canvas");
    snapshot.className = canvas.className;
    const drawImage = vi.fn();
    Object.defineProperty(snapshot, "getContext", {
      configurable: true,
      value: vi.fn((type: string) => type === "2d" ? { drawImage } : null)
    });
    Object.defineProperty(canvas, "cloneNode", {
      configurable: true,
      value: vi.fn(() => snapshot)
    });
    let renderListener: (() => void) | null = null;
    const map = {
      getCanvas: () => canvas,
      on: vi.fn((_event: "render", listener: () => void) => { renderListener = listener; }),
      off: vi.fn((_event: "render", listener: () => void) => {
        if (renderListener === listener) renderListener = null;
      }),
      triggerRepaint: vi.fn(() => { renderListener?.(); })
    };
    const capture = vi.fn(async () => {
      expect(container.firstElementChild).toBe(snapshot);
      expect(container.querySelector(".maplibregl-ctrl-zoom-in")).toBe(control);
      return null;
    });
    const provider = createMapLibreEvidenceProvider({ capture, maps: () => [map] });

    await provider({} as never);

    expect(drawImage).toHaveBeenCalledWith(canvas, 0, 0);
    expect(capture).toHaveBeenCalledOnce();
    expect(container.firstElementChild).toBe(canvas);
    expect(map.off).toHaveBeenCalledWith("render", expect.any(Function));
  });

  it("preserveDrawingBuffer設定と設定漏れ検出を公開する", () => {
    const canvas = document.createElement("canvas");
    canvas.className = "maplibregl-canvas";
    Object.defineProperty(canvas, "getContext", {
      configurable: true,
      value: vi.fn((type: string) => type === "webgl2"
        ? { getContextAttributes: () => ({ preserveDrawingBuffer: false }) }
        : null)
    });
    document.body.append(canvas);

    expect(captureReadyCanvasContextAttributes).toEqual({ preserveDrawingBuffer: true });
    expect(findUnreadableMapCanvases(document)).toEqual([canvas]);
  });
});
