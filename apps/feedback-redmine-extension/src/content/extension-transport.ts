import {
  parseCurrentUserResult,
  parseProfileResult,
  parseThreadListResult,
  parseThreadResult,
  RedmineFeedbackError,
  isRedmineErrorCode,
  sha256Hex,
  type AbortSignalLike,
  type RedmineAttachmentContent,
  type RedmineAttachmentInput,
  type RedmineCurrentPrincipalV1,
  type RedmineFeedbackPort,
  type RedmineProfileResult,
  type RedmineThreadCreateInput,
  type RedmineThreadListInput,
  type RedmineThreadListResult,
  type RedmineThreadLookupInput,
  type RedmineThreadV1
} from "@feedback/redmine-core";
import { rawChunkSize } from "../background/evidence-staging.js";

export type RuntimePortLike = {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
};

export type RuntimeLike = {
  sendMessage(message: unknown): Promise<unknown>;
  connect(connectInfo: { name: string }): RuntimePortLike;
};

export class ExtensionRedmineFeedbackTransport implements RedmineFeedbackPort {
  constructor(private readonly profileId: string, private readonly runtime: RuntimeLike) {}

  async getCapabilities(profileId: string): Promise<RedmineProfileResult> {
    this.assertProfile(profileId);
    return parseProfileResult(await this.send("redmine.profile.get.v1", { profileId }));
  }

  async getCurrentUser(profileId: string): Promise<RedmineCurrentPrincipalV1> {
    this.assertProfile(profileId);
    return parseCurrentUserResult(await this.send("redmine.current-user.get.v1", { profileId }));
  }

  async listThreads(input: RedmineThreadListInput): Promise<RedmineThreadListResult> {
    this.assertProfile(input.profileId);
    return parseThreadListResult(await this.send("redmine.thread.list.v1", {
      profileId: input.profileId,
      resourceRef: input.resourceRef,
      pageKey: input.pageKey,
      sort: input.sort,
      ...(input.filter === undefined ? {} : { filter: input.filter }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor })
    }));
  }

  async getThread(input: RedmineThreadLookupInput): Promise<RedmineThreadV1> {
    this.assertProfile(input.profileId);
    return parseThreadResult(await this.send("redmine.thread.get.v1", input));
  }

  async createThread(
    input: RedmineThreadCreateInput,
    evidenceBytes: Uint8Array | null,
    signal?: AbortSignalLike
  ): Promise<RedmineThreadV1> {
    this.assertProfile(input.profileId);
    const requestId = crypto.randomUUID();
    if (input.evidence && evidenceBytes) await this.transferEvidence(requestId, input.evidence, evidenceBytes, signal);
    else if (input.evidence || evidenceBytes) throw contractError("evidence metadataとbytesが一致しません");
    return parseThreadResult(await this.send("redmine.thread.create.v1", input, requestId));
  }

  async getAttachment(input: RedmineAttachmentInput, signal?: AbortSignalLike): Promise<RedmineAttachmentContent> {
    this.assertProfile(input.profileId);
    const requestId = crypto.randomUUID();
    const port = this.runtime.connect({ name: "feedback-redmine-attachment-v1" });
    return new Promise((resolve, reject) => {
      let metadata: { filename: string; contentType: string; byteSize: number; sha256: string; totalChunks: number } | null = null;
      const chunks: Uint8Array[] = [];
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        port.disconnect();
        reject(error);
      };
      const abort = () => fail(new DOMException("Aborted", "AbortError"));
      signal?.addEventListener?.("abort", abort, { once: true });
      port.onMessage.addListener((message) => {
        void (async () => {
          const envelope = object(message, "attachment message");
          if (envelope.requestId !== requestId) throw contractError("attachment request IDが一致しません");
          if (envelope.ok === false) throw responseError(envelope);
          const payload = object(envelope.payload, "attachment payload");
          if (envelope.type === "redmine.attachment.stream.start.v1") {
            if (metadata || payload.rawChunkSize !== rawChunkSize) throw contractError("attachment startが不正です");
            metadata = {
              filename: text(payload.filename, "filename", 255),
              contentType: text(payload.contentType, "contentType", 255),
              byteSize: integer(payload.byteSize, "byteSize", 0, 52_428_800),
              sha256: sha(payload.sha256),
              totalChunks: integer(payload.totalChunks, "totalChunks", 0, 267)
            };
          } else if (envelope.type === "redmine.attachment.stream.chunk.v1") {
            if (!metadata || payload.index !== chunks.length) throw contractError("attachment chunk順序が不正です");
            chunks.push(base64Bytes(text(payload.data, "data", 262_144)));
          } else if (envelope.type === "redmine.attachment.stream.complete.v1") {
            if (!metadata || chunks.length !== metadata.totalChunks || Object.keys(payload).length !== 0) throw contractError("attachment completeが不正です");
            const bytes = join(chunks);
            if (bytes.byteLength !== metadata.byteSize || await sha256Hex(bytes) !== metadata.sha256) throw contractError("attachment byte数またはSHA-256が一致しません");
            settled = true;
            signal?.removeEventListener?.("abort", abort);
            resolve({ bytes, filename: metadata.filename, contentType: metadata.contentType, sha256: metadata.sha256 });
          } else throw contractError("attachment message typeが不正です");
        })().catch(fail);
      });
      port.onDisconnect.addListener(() => {
        if (!settled) fail(contractError("attachment Portが完了前に切断されました"));
      });
      port.postMessage(envelope(requestId, "redmine.attachment.get.v1", input));
    });
  }

  private async send(type: string, payload: unknown, requestId = crypto.randomUUID()): Promise<unknown> {
    let rawResponse: unknown;
    try {
      rawResponse = await this.runtime.sendMessage(envelope(requestId, type, payload));
    } catch (cause) {
      throw new RedmineFeedbackError("redmine.unavailable", "extension service workerへ接続できません", {
        retryable: true,
        cause
      });
    }
    const response = object(rawResponse, "operation response");
    if (response.contractVersion !== "1" || response.requestId !== requestId || response.type !== type || typeof response.ok !== "boolean") {
      throw contractError("operation response envelopeが不正です");
    }
    if (!response.ok) throw responseError(response);
    if (!("result" in response)) throw contractError("operation resultがありません");
    return response.result;
  }

  private transferEvidence(
    requestId: string,
    metadata: NonNullable<RedmineThreadCreateInput["evidence"]>,
    bytes: Uint8Array,
    signal?: AbortSignalLike
  ): Promise<void> {
    if (bytes.byteLength !== metadata.byteSize) return Promise.reject(contractError("evidence byte数が一致しません"));
    const port = this.runtime.connect({ name: "feedback-redmine-evidence-v1" });
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        port.disconnect();
        reject(error);
      };
      const abort = () => fail(new DOMException("Aborted", "AbortError"));
      signal?.addEventListener?.("abort", abort, { once: true });
      port.onMessage.addListener((message) => {
        const response = object(message, "evidence response");
        if (response.contractVersion !== "1" || response.requestId !== requestId ||
          response.type !== "evidence.stream.result.v1" || response.ok !== true || Object.keys(response).length !== 4) {
          return fail(contractError("evidence transferに失敗しました"));
        }
        settled = true;
        signal?.removeEventListener?.("abort", abort);
        port.disconnect();
        resolve();
      });
      port.onDisconnect.addListener(() => {
        if (!settled) fail(contractError("evidence Portが完了前に切断されました"));
      });
      port.postMessage(envelope(requestId, "evidence.stream.start.v1", { profileId: this.profileId, metadata }));
      for (let index = 0; index * rawChunkSize < bytes.byteLength; index += 1) {
        port.postMessage(envelope(requestId, "evidence.stream.chunk.v1", {
          index,
          data: bytesToBase64(bytes.slice(index * rawChunkSize, (index + 1) * rawChunkSize))
        }));
      }
      port.postMessage(envelope(requestId, "evidence.stream.complete.v1", {}));
    });
  }

  private assertProfile(profileId: string): void {
    if (profileId !== this.profileId) throw contractError("transport profile IDが一致しません");
  }
}

function envelope(requestId: string, type: string, payload: unknown) {
  return { contractVersion: "1", requestId, type, payload };
}
function responseError(response: Record<string, unknown>): RedmineFeedbackError {
  const error = object(response.error, "operation error");
  const code = text(error.code, "error code", 100);
  if (!isRedmineErrorCode(code)) throw contractError("operation error codeが不正です");
  return new RedmineFeedbackError(code, text(error.message, "error message", 500), {
    retryable: error.retryable === true,
    upstreamStatus: typeof error.upstreamStatus === "number" ? error.upstreamStatus : null
  });
}
function contractError(message: string) { return new RedmineFeedbackError("redmine.contract_invalid", message); }
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw contractError(`${name}がobjectではありません`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum) throw contractError(`${name}が不正です`);
  return value;
}
function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw contractError(`${name}が不正です`);
  return value as number;
}
function sha(value: unknown): string {
  const result = text(value, "sha256", 64);
  if (!/^[a-f0-9]{64}$/u.test(result)) throw contractError("SHA-256が不正です");
  return result;
}
function base64Bytes(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw contractError("base64が不正です");
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
function join(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
