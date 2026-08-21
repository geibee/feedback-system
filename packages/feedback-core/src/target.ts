import type { FeedbackTargetV1 } from "@geibee/feedback-contracts";

export function parseFeedbackTarget(value: unknown): FeedbackTargetV1 | null {
  if (!isRecord(value) || value.schemaVersion !== "1" || typeof value.kind !== "string") return null;
  switch (value.kind) {
    case "ui-element":
      return hasOnlyKeys(value, ["schemaVersion", "kind", "elementKey", "relativeX", "relativeY"]) &&
        isStableKey(value.elementKey) && isRelativePoint(value)
        ? {
            schemaVersion: "1",
            kind: "ui-element",
            elementKey: value.elementKey.trim(),
            relativeX: value.relativeX,
            relativeY: value.relativeY
          }
        : null;
    case "screen-position":
      return hasOnlyKeys(value, ["schemaVersion", "kind", "relativeX", "relativeY"]) && isRelativePoint(value)
        ? { schemaVersion: "1", kind: "screen-position", relativeX: value.relativeX, relativeY: value.relativeY }
        : null;
    case "map-feature":
      return hasOnlyKeys(value, [
        "schemaVersion", "kind", "provider", "sourceKey", "sourceLayer", "featureKey", "longitude", "latitude"
      ]) && value.provider === "maplibre" && isStableKey(value.sourceKey) &&
        isStableKey(value.featureKey) && isCoordinate(value)
        ? {
            schemaVersion: "1",
            kind: "map-feature",
            provider: "maplibre",
            sourceKey: value.sourceKey.trim(),
            ...(isStableKey(value.sourceLayer) ? { sourceLayer: value.sourceLayer.trim() } : {}),
            featureKey: value.featureKey.trim(),
            longitude: value.longitude,
            latitude: value.latitude
          }
        : null;
    case "map-position":
      return hasOnlyKeys(value, ["schemaVersion", "kind", "longitude", "latitude"]) && isCoordinate(value)
        ? { schemaVersion: "1", kind: "map-position", longitude: value.longitude, latitude: value.latitude }
        : null;
    case "custom":
      return hasOnlyKeys(value, [
        "schemaVersion", "kind", "provider", "targetKey", "fallbackRelativeX", "fallbackRelativeY", "metadata"
      ]) && isCustomProvider(value.provider) && isTextWithin(value.targetKey, 200) &&
        isRelative(value.fallbackRelativeX) && isRelative(value.fallbackRelativeY) &&
        (value.metadata === undefined || isCustomMetadata(value.metadata))
        ? {
            schemaVersion: "1",
            kind: "custom",
            provider: value.provider,
            targetKey: value.targetKey,
            fallbackRelativeX: value.fallbackRelativeX,
            fallbackRelativeY: value.fallbackRelativeY,
            ...(value.metadata === undefined ? {} : { metadata: { ...value.metadata } })
          }
        : null;
    default:
      return null;
  }
}

export function assertFeedbackTarget(value: unknown): asserts value is FeedbackTargetV1 {
  if (!parseFeedbackTarget(value)) throw new Error("FeedbackTargetV1に適合しません");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStableKey(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 200;
}

function isTextWithin(value: unknown, maximum: number): value is string {
  return typeof value === "string" && Array.from(value).length > 0 && Array.from(value).length <= maximum;
}

function isCustomProvider(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,99}$/u.test(value);
}

function isRelative(value: unknown): value is number {
  return isNumber(value) && value >= 0 && value <= 1;
}

function isCustomMetadata(
  value: unknown
): value is Record<string, string | number | boolean | null> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 20 && entries.every(([key, entry]) =>
    key.length <= 64 && /^[A-Za-z][A-Za-z0-9_.-]*$/u.test(key) && (
      entry === null || typeof entry === "boolean" ||
      (typeof entry === "string" && Array.from(entry).length <= 500) || isNumber(entry)
    )
  );
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRelativePoint(value: Record<string, unknown>): value is Record<string, unknown> & {
  relativeX: number;
  relativeY: number;
} {
  return isRelative(value.relativeX) && isRelative(value.relativeY);
}

function isCoordinate(value: Record<string, unknown>): value is Record<string, unknown> & {
  longitude: number;
  latitude: number;
} {
  return isNumber(value.longitude) && isNumber(value.latitude) &&
    value.longitude >= -180 && value.longitude <= 180 && value.latitude >= -90 && value.latitude <= 90;
}
