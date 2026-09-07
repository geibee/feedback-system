import { readFile } from "node:fs/promises";
import type { FeedbackProviderProfileV2 } from "@geibee/feedback-contracts/v2/server";
import {
  createFeedbackConnectorAdapterRegistry,
  type BacklogRuntimeProfile,
  type FeedbackConnectorAdapterRegistry,
  type FeedbackConnectorRuntimeProfile,
  type JiraCloudRuntimeProfile,
  type RedmineRuntimeProfile
} from "./connector-registry.js";

export type { BacklogRuntimeProfile, FeedbackConnectorRuntimeProfile, JiraCloudRuntimeProfile, RedmineRuntimeProfile };

export type FeedbackConnectorCatalog = {
  schemaVersion: "1";
  profiles: ReadonlyMap<string, FeedbackConnectorRuntimeProfile>;
};

/** provider固有profile解析をadapter registryへ委譲し、catalog自体は分岐を持たない。 */
export async function loadFeedbackConnectorCatalog(
  absolutePath: string,
  registry: FeedbackConnectorAdapterRegistry = createFeedbackConnectorAdapterRegistry()
): Promise<FeedbackConnectorCatalog> {
  if (!absolutePath.startsWith("/") || absolutePath.includes("\0")) throw new Error("Connector catalog fileはabsolute pathで指定してください");
  const source = await readFile(absolutePath, "utf8");
  if (source.length > 1_048_576) throw new Error("Connector catalogが上限を超えています");
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error("Connector catalog JSONが不正です"); }
  const root = record(value, "Connector catalog");
  if (Object.keys(root).length !== 2 || !("schemaVersion" in root) || !("profiles" in root) || root.schemaVersion !== "1") throw new Error("Connector catalog schemaVersionまたはfieldが不正です");
  if (!Array.isArray(root.profiles) || root.profiles.length === 0 || root.profiles.length > 100) throw new Error("Connector catalog profilesが不正です");
  const profiles = new Map<string, FeedbackConnectorRuntimeProfile>();
  for (const entry of root.profiles) {
    const candidate = record(entry, "Connector profile");
    if (typeof candidate.connectorKey !== "string") throw new Error("Connector keyが不正です");
    const adapter = registry.require(candidate.connectorKey);
    const profile = adapter.freezeProfile(adapter.parseProfile(entry));
    if (profiles.has(profile.id)) throw new Error(`Connector catalog profile IDが重複しています: ${profile.id}`);
    profiles.set(profile.id, profile);
  }
  return Object.freeze({ schemaVersion: "1", profiles: readonlyMap(profiles) });
}

export function validateConnectorCatalogBindings(
  catalog: FeedbackConnectorCatalog,
  profiles: readonly FeedbackProviderProfileV2[],
  registry: FeedbackConnectorAdapterRegistry = createFeedbackConnectorAdapterRegistry()
): void {
  for (const profile of profiles) {
    if (!profile.connectorProfileRef) throw new Error(`connectorProfileRefがありません: ${profile.profileId}`);
    const runtime = catalog.profiles.get(profile.connectorProfileRef);
    if (!runtime) throw new Error(`Connector catalog profileがありません: ${profile.connectorProfileRef}`);
    if (runtime.connectorKey !== profile.connectorKey) throw new Error(`Connector keyが一致しません: ${profile.profileId}`);
    registry.require(runtime.connectorKey).validateBinding(runtime, profile);
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name}がobjectではありません`);
  return value as Record<string, unknown>;
}

function readonlyMap<K, V>(source: Map<K, V>): ReadonlyMap<K, V> {
  return Object.freeze({
    get size() { return source.size; },
    get(key: K) { return source.get(key); },
    has(key: K) { return source.has(key); },
    entries() { return source.entries(); },
    keys() { return source.keys(); },
    values() { return source.values(); },
    forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) { source.forEach((value, key) => callback.call(thisArg, value, key, this)); },
    [Symbol.iterator]() { return source[Symbol.iterator](); }
  });
}
