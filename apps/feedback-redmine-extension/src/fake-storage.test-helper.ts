import type { ExtensionStorage, StorageAreaLike } from "./storage/chrome-storage.js";

export class FakeArea implements StorageAreaLike {
  readonly data: Record<string, unknown>;
  readonly accessLevels: string[] = [];
  constructor(initial: Record<string, unknown> = {}) { this.data = structuredClone(initial); }
  async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
    if (keys === undefined || keys === null) return structuredClone(this.data);
    const names = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(names.filter((key) => key in this.data).map((key) => [key, structuredClone(this.data[key])]));
  }
  async set(items: Record<string, unknown>): Promise<void> { Object.assign(this.data, structuredClone(items)); }
  async remove(keys: string | string[]): Promise<void> { for (const key of Array.isArray(keys) ? keys : [keys]) delete this.data[key]; }
  async setAccessLevel(options: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void> { this.accessLevels.push(options.accessLevel); }
}

export function fakeStorage(options: { local?: Record<string, unknown>; session?: Record<string, unknown>; managed?: Record<string, unknown> } = {}) {
  const local = new FakeArea(options.local);
  const session = new FakeArea(options.session);
  const managed = new FakeArea(options.managed);
  return { local, session, managed } satisfies ExtensionStorage;
}
