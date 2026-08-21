import type { MapGeoJSONFeature } from "maplibre-gl";
import type { FeedbackTargetV1, FeedbackThreadV1 } from "@geibee/feedback-contracts";
import type { FeedbackEvidenceProvider, FeedbackPinPositionProvider } from "@geibee/feedback-core";

export const maplibreCanvasSelector = "canvas.maplibregl-canvas";
export const captureReadyCanvasContextAttributes = { preserveDrawingBuffer: true } as const;

export type FeedbackMapLibreEvidenceMap = {
  getCanvas(): HTMLCanvasElement;
  on(event: "render", listener: () => void): unknown;
  off(event: "render", listener: () => void): unknown;
  triggerRepaint(): void;
};

export type FeedbackMapLibreEvidenceProviderOptions = {
  /** DOM全体をPNG化するprovider。通常は@geibee/reactのcreateDomEvidenceProviderを渡す。 */
  capture: FeedbackEvidenceProvider;
  /** React refの初期化順を吸収し、画面内に存在するMapLibre mapを撮影時点で返す。 */
  maps(): readonly FeedbackMapLibreEvidenceMap[];
  /** triggerRepaint後のrender待機上限。 */
  renderTimeoutMs?: number;
};

type FrozenMapCanvas = {
  canvas: HTMLCanvasElement;
  snapshot: HTMLCanvasElement;
  parent: Node;
};

/**
 * MapLibreのrender event内でWebGL canvasを2D canvasへ固定してからDOM証跡を取得する。
 * preserveDrawingBufferを常時有効にせず、MapLibre controlsを含むDOM全体を1枚に合成できる。
 */
export function createMapLibreEvidenceProvider(
  options: FeedbackMapLibreEvidenceProviderOptions
): FeedbackEvidenceProvider {
  return async (request) => {
    const maps = [...new Set(options.maps())];
    const frozen = await Promise.all(maps.map((map) => freezeMapCanvas(
      map,
      options.renderTimeoutMs ?? 1_000
    )));
    const installed = frozen.flatMap((item) => item && installFrozenCanvas(item) ? [item] : []);
    try {
      return await options.capture(request);
    } finally {
      installed.reverse().forEach(restoreFrozenCanvas);
    }
  };
}

/** preserveDrawingBuffer無効のMapLibre canvasを検出し、旧来のDOM capture設定漏れを可視化する。 */
export function findUnreadableMapCanvases(
  root: ParentNode,
  selector: string = maplibreCanvasSelector
): HTMLCanvasElement[] {
  return Array.from(root.querySelectorAll<HTMLCanvasElement>(selector)).filter(
    (canvas) => preservesDrawingBuffer(canvas) === false
  );
}

function preservesDrawingBuffer(canvas: HTMLCanvasElement): boolean | null {
  const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  if (!context) return null;
  return context.getContextAttributes()?.preserveDrawingBuffer === true;
}

async function freezeMapCanvas(
  map: FeedbackMapLibreEvidenceMap,
  timeoutMs: number
): Promise<FrozenMapCanvas | null> {
  const canvas = map.getCanvas();
  const parent = canvas.parentNode;
  if (!parent || !canvas.isConnected || canvas.width === 0 || canvas.height === 0) return null;
  const snapshot = await new Promise<HTMLCanvasElement>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      map.off("render", onRender);
      if (timer !== undefined) clearTimeout(timer);
    };
    const onRender = () => {
      cleanup();
      try {
        resolve(copyCanvasBitmap(canvas));
      } catch (error) {
        reject(error);
      }
    };
    map.on("render", onRender);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("MapLibreの再描画が完了せず、地図を証跡へ取り込めませんでした"));
    }, Math.max(1, timeoutMs));
    try {
      map.triggerRepaint();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
  return { canvas, snapshot, parent };
}

function copyCanvasBitmap(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const snapshot = canvas.cloneNode(false) as HTMLCanvasElement;
  snapshot.width = canvas.width;
  snapshot.height = canvas.height;
  const context = snapshot.getContext("2d");
  if (!context) throw new Error("MapLibre証跡用の2D canvasを作成できませんでした");
  context.drawImage(canvas, 0, 0);
  return snapshot;
}

function installFrozenCanvas(value: FrozenMapCanvas): boolean {
  if (value.canvas.parentNode !== value.parent) return false;
  value.parent.replaceChild(value.snapshot, value.canvas);
  return true;
}

function restoreFrozenCanvas(value: FrozenMapCanvas): void {
  if (value.snapshot.parentNode === value.parent) {
    value.parent.replaceChild(value.canvas, value.snapshot);
  }
}

export type FeedbackMapLibreTargetOptions = {
  layers?: string[];
  /** MapLibre source ID を製品横断で安定した source key へ変換する。 */
  toSourceKey(feature: MapGeoJSONFeature): string | null;
  /** feature.id や業務属性を安定した feature key へ変換する。 */
  toFeatureKey(feature: MapGeoJSONFeature): string | null;
};

export type FeedbackMapLibreMap = {
  queryRenderedFeatures(
    point: [number, number],
    options?: { layers?: string[] }
  ): MapGeoJSONFeature[];
};

export type FeedbackMapLibrePointer = {
  point: { x: number; y: number };
  lngLat: { lng: number; lat: number };
};

export type FeedbackMapLibreClientPointMap = FeedbackMapLibreMap & {
  getCanvas(): HTMLCanvasElement;
  unproject(point: [number, number]): { lng: number; lat: number };
};

/** MapLibre 固有 ID を host adapter で安定 key に変換して FeedbackTargetV1 を作る。 */
export function resolveMapLibreFeedbackTarget(
  map: FeedbackMapLibreMap,
  event: FeedbackMapLibrePointer,
  options: FeedbackMapLibreTargetOptions
): FeedbackTargetV1 {
  const position: FeedbackTargetV1 = {
    schemaVersion: "1",
    kind: "map-position",
    longitude: event.lngLat.lng,
    latitude: event.lngLat.lat
  };
  if (options.layers?.length === 0) return position;

  const [feature] = map.queryRenderedFeatures(
    [event.point.x, event.point.y],
    options.layers ? { layers: options.layers } : undefined
  );
  if (!feature) return position;
  const sourceKey = options.toSourceKey(feature)?.trim();
  const featureKey = options.toFeatureKey(feature)?.trim();
  if (!sourceKey || !featureKey) return position;
  return {
    schemaVersion: "1",
    kind: "map-feature",
    provider: "maplibre",
    sourceKey,
    ...(feature.sourceLayer ? { sourceLayer: feature.sourceLayer } : {}),
    featureKey,
    longitude: event.lngLat.lng,
    latitude: event.lngLat.lat
  };
}

/** browserのclient座標をcanvas内座標と経緯度へ変換し、OverlayのtargetResolverから利用できるtargetを作る。 */
export function resolveMapLibreFeedbackTargetAtClientPoint(
  map: FeedbackMapLibreClientPointMap,
  input: { clientX: number; clientY: number },
  options: FeedbackMapLibreTargetOptions
): FeedbackTargetV1 {
  const bounds = map.getCanvas().getBoundingClientRect();
  const point = {
    x: input.clientX - bounds.left,
    y: input.clientY - bounds.top
  };
  return resolveMapLibreFeedbackTarget(map, {
    point,
    lngLat: map.unproject([point.x, point.y])
  }, options);
}

export type FeedbackMapLibreMarker = { remove(): void };

export type FeedbackMapLibrePinPositionMap = {
  getCanvas(): HTMLCanvasElement;
  project(lngLat: [number, number]): { x: number; y: number };
  on(event: "move" | "resize" | "styledata" | "remove", listener: () => void): unknown;
  off(event: "move" | "resize" | "styledata" | "remove", listener: () => void): unknown;
};

export type FeedbackMapLibrePinPositionProvider = FeedbackPinPositionProvider;

/** 保存済み経緯度をviewport座標へ投影し、地図の表示変更をOverlay pinへ通知する。 */
export function createMapLibreFeedbackPinPositionProvider(
  map: FeedbackMapLibrePinPositionMap
): FeedbackMapLibrePinPositionProvider {
  const listeners = new Set<() => void>();
  let listening = false;
  let removed = false;
  const positionEvents = ["move", "resize", "styledata"] as const;
  const notify = () => listeners.forEach((listener) => listener());
  const detach = () => {
    if (!listening) return;
    positionEvents.forEach((event) => map.off(event, notify));
    map.off("remove", handleRemove);
    listening = false;
  };
  const handleRemove = () => {
    removed = true;
    detach();
    notify();
  };
  const attach = () => {
    if (listening || removed) return;
    positionEvents.forEach((event) => map.on(event, notify));
    map.on("remove", handleRemove);
    listening = true;
  };
  return {
    getPosition(target) {
      if (removed || (target.kind !== "map-feature" && target.kind !== "map-position")) return null;
      const canvas = map.getCanvas();
      if (!canvas.isConnected) return null;
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return null;
      const point = map.project([target.longitude, target.latitude]);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) ||
          point.x < 0 || point.x > bounds.width || point.y < 0 || point.y > bounds.height) {
        return null;
      }
      return { x: bounds.left + point.x, y: bounds.top + point.y };
    },
    subscribe(listener) {
      if (removed) return () => undefined;
      listeners.add(listener);
      attach();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) detach();
      };
    }
  };
}

export type FeedbackMapLibrePinMap = {
  on(event: "styledata" | "remove", listener: () => void): void;
  off(event: "styledata" | "remove", listener: () => void): void;
  getLayer?(id: string): unknown;
};

export type FeedbackMapLibrePinBindingOptions = {
  /** style reload 後に必要な host layer が存在するかを判定する。 */
  requiredLayerIds?: readonly string[];
  createMarker(
    thread: FeedbackThreadV1,
    target: Extract<FeedbackTargetV1, { kind: "map-feature" | "map-position" }>
  ): FeedbackMapLibreMarker;
};

/** style reload・layer消滅・map unloadで marker を必ず再構築/破棄する lifecycle adapter。 */
export function bindMapLibreFeedbackPins(
  map: FeedbackMapLibrePinMap,
  options: FeedbackMapLibrePinBindingOptions
): { update(threads: readonly FeedbackThreadV1[]): void; destroy(): void } {
  let current: readonly FeedbackThreadV1[] = [];
  let markers: FeedbackMapLibreMarker[] = [];
  let destroyed = false;
  const clear = () => {
    markers.forEach((marker) => marker.remove());
    markers = [];
  };
  const render = () => {
    clear();
    if (destroyed) return;
    if (options.requiredLayerIds?.some((layer) => !map.getLayer?.(layer))) return;
    markers = current.flatMap((thread) => {
      const target = thread.target;
      return target.kind === "map-feature" || target.kind === "map-position"
        ? [options.createMarker(thread, target)]
        : [];
    });
  };
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    map.off("styledata", render);
    map.off("remove", destroy);
    clear();
  };
  map.on("styledata", render);
  map.on("remove", destroy);
  return {
    update(threads) {
      current = [...threads];
      render();
    },
    destroy
  };
}
