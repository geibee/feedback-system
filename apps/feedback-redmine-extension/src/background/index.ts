import { CredentialVault } from "./credential-vault.js";
import { ClientStateMessageHandler } from "./client-state-handler.js";
import { EvidenceStaging, rawChunkSize } from "./evidence-staging.js";
import { ExtensionMessageHandler } from "./message-handler.js";
import { synchronizeContentScriptRegistration } from "./registration.js";
import {
  ExtensionProfileRepository,
  TrustedChromeClientState,
  restrictExtensionStorage,
  type ExtensionStorage
} from "../storage/chrome-storage.js";

const storage = chrome.storage as unknown as ExtensionStorage;
const profiles = new ExtensionProfileRepository(storage);
const vault = new CredentialVault(storage);
const evidence = new EvidenceStaging();
const operations = new ExtensionMessageHandler(chrome.runtime.id, profiles, vault, evidence);
const clientState = new ClientStateMessageHandler(chrome.runtime.id, profiles, new TrustedChromeClientState(storage));

const ready = restrictExtensionStorage(storage);
void ready.then(() => synchronizeContentScriptRegistration(chrome.scripting, profiles, chrome.permissions));
chrome.runtime.onInstalled.addListener(() => void ready.then(() =>
  synchronizeContentScriptRegistration(chrome.scripting, profiles, chrome.permissions)
));
chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName === "local" || areaName === "managed") {
    void ready.then(() => synchronizeContentScriptRegistration(chrome.scripting, profiles, chrome.permissions));
  }
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const type = message && typeof message === "object" ? (message as { type?: unknown }).type : null;
  const promise: Promise<unknown> = ready.then(async () => {
    if (typeof type === "string" && type.startsWith("client-state.")) return clientState.handle(message, sender);
    return operations.handle(message, sender);
  });
  void promise.then(sendResponse);
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "feedback-redmine-bootstrap-v1") {
    void ready.then(() => operations.bootstrap(port.sender ?? {})).then((response) => {
      port.postMessage(response);
      port.disconnect();
    });
    return;
  }
  if (port.name === "feedback-redmine-evidence-v1") {
    handleEvidencePort(port);
    return;
  }
  if (port.name === "feedback-redmine-attachment-v1") handleAttachmentPort(port);
});

function handleEvidencePort(port: chrome.runtime.Port): void {
  let requestId: string | null = null;
  let index = 0;
  let queue: Promise<void> = ready;
  port.onMessage.addListener((message: unknown) => {
    queue = queue.then(async () => {
      const item = exactObject(message, ["contractVersion", "requestId", "type", "payload"]);
      if (item.contractVersion !== "1") throw new Error("evidence contract versionが不正です");
      const messageRequestId = uuid(item.requestId);
      const payload = object(item.payload);
      if (item.type === "evidence.stream.start.v1") {
        if (requestId) throw new Error("evidence startが重複しています");
        exactObject(payload, ["profileId", "metadata"]);
        requestId = messageRequestId;
        const metadata = await operations.authorizeEvidenceStart(payload.profileId, payload.metadata, port.sender ?? {});
        evidence.start(requestId, metadata);
      } else if (item.type === "evidence.stream.chunk.v1" && requestId) {
        exactObject(payload, ["index", "data"]);
        if (messageRequestId !== requestId || payload.index !== index) throw new Error("evidence chunk順序が不正です");
        evidence.append(requestId, index, text(payload.data));
        index += 1;
      } else if (item.type === "evidence.stream.complete.v1" && requestId) {
        exactObject(payload, []);
        if (messageRequestId !== requestId) throw new Error("evidence request IDが一致しません");
        evidence.complete(requestId);
        port.postMessage({ contractVersion: "1", requestId, type: "evidence.stream.result.v1", ok: true });
      } else throw new Error("evidence messageが不正です");
    }).catch(() => {
      if (requestId) evidence.discard(requestId);
      port.postMessage({
        contractVersion: "1",
        requestId: requestId ?? crypto.randomUUID(),
        type: "evidence.stream.result.v1",
        ok: false
      });
      port.disconnect();
    });
  });
  port.onDisconnect.addListener(() => {
    if (requestId) setTimeout(() => evidence.cleanup(), 120_000);
  });
}

function handleAttachmentPort(port: chrome.runtime.Port): void {
  const controller = new AbortController();
  let handled = false;
  port.onDisconnect.addListener(() => controller.abort());
  port.onMessage.addListener((message: unknown) => {
    if (handled) return;
    handled = true;
    void ready.then(() => operations.getAttachment(message, port.sender ?? {}, controller.signal)).then(({ request, content }) => {
      const totalChunks = Math.ceil(content.bytes.byteLength / rawChunkSize);
      port.postMessage({
        contractVersion: "1", requestId: request.requestId, type: "redmine.attachment.stream.start.v1",
        payload: {
          filename: content.filename, contentType: content.contentType, byteSize: content.bytes.byteLength,
          sha256: content.sha256, rawChunkSize, totalChunks
        }
      });
      for (let index = 0; index < totalChunks; index += 1) {
        const bytes = content.bytes.slice(index * rawChunkSize, (index + 1) * rawChunkSize);
        port.postMessage({
          contractVersion: "1", requestId: request.requestId, type: "redmine.attachment.stream.chunk.v1",
          payload: { index, data: bytesToBase64(bytes) }
        });
      }
      port.postMessage({
        contractVersion: "1", requestId: request.requestId, type: "redmine.attachment.stream.complete.v1", payload: {}
      });
      port.disconnect();
    }).catch(async (error: unknown) => {
      const response = await operations.failure(message, error);
      port.postMessage(response);
      port.disconnect();
    });
  });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Port messageが不正です");
  return value as Record<string, unknown>;
}
function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const item = object(value);
  if (Object.keys(item).length !== keys.length || Object.keys(item).some((key) => !keys.includes(key)) || keys.some((key) => !(key in item))) {
    throw new Error("Port message shapeが不正です");
  }
  return item;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 262_144) throw new Error("Port textが不正です");
  return value;
}
function uuid(value: unknown): string {
  const result = text(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(result)) {
    throw new Error("Port request IDがUUIDではありません");
  }
  return result;
}
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 8192)));
  }
  return btoa(binary);
}
