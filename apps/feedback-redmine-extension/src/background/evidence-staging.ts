import type { RedmineEvidenceMetadata } from "@feedback/redmine-core";

type EvidenceEntry = {
  metadata: RedmineEvidenceMetadata;
  chunks: Uint8Array[];
  length: number;
  complete: boolean;
  createdAt: number;
};

export class EvidenceStaging {
  readonly #entries = new Map<string, EvidenceEntry>();

  start(requestId: string, metadata: RedmineEvidenceMetadata): void {
    this.cleanup();
    if (this.#entries.has(requestId)) throw new Error("evidence request IDが重複しています");
    this.#entries.set(requestId, { metadata, chunks: [], length: 0, complete: false, createdAt: Date.now() });
  }

  append(requestId: string, index: number, base64: string): void {
    const entry = this.#entry(requestId);
    if (entry.complete || index !== entry.chunks.length || !base64Pattern.test(base64)) throw new Error("evidence chunkが不正です");
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    if (bytes.byteLength > rawChunkSize || entry.length + bytes.byteLength > entry.metadata.byteSize) {
      throw new Error("evidence chunk sizeが不正です");
    }
    entry.chunks.push(bytes);
    entry.length += bytes.byteLength;
  }

  complete(requestId: string): void {
    const entry = this.#entry(requestId);
    if (entry.length !== entry.metadata.byteSize) throw new Error("evidence総byte数が一致しません");
    entry.complete = true;
  }

  take(requestId: string, metadata: RedmineEvidenceMetadata | null): Uint8Array | null {
    if (!metadata) {
      if (this.#entries.has(requestId)) throw new Error("evidence metadataがありません");
      return null;
    }
    const entry = this.#entry(requestId);
    this.#entries.delete(requestId);
    if (!entry.complete || JSON.stringify(entry.metadata) !== JSON.stringify(metadata)) throw new Error("evidence metadataが一致しません");
    const result = new Uint8Array(entry.length);
    let offset = 0;
    for (const chunk of entry.chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }

  discard(requestId: string): void {
    this.#entries.delete(requestId);
  }

  cleanup(now = Date.now()): void {
    for (const [requestId, entry] of this.#entries) {
      if (now - entry.createdAt > 120_000) this.#entries.delete(requestId);
    }
  }

  #entry(requestId: string): EvidenceEntry {
    const entry = this.#entries.get(requestId);
    if (!entry) throw new Error("evidence transferが見つかりません");
    return entry;
  }
}

export const rawChunkSize = 196_608;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
