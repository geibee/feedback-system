import type {
  AbortSignalLike,
  RedmineAttachmentContent,
  RedmineAttachmentInput,
  RedmineCurrentPrincipalV1,
  RedmineFeedbackPort,
  RedmineMessageCreateInput,
  RedmineMessageUpdateInput,
  RedmineParticipantV1,
  RedmineProfileResult,
  RedmineThreadCreateInput,
  RedmineThreadListInput,
  RedmineThreadListResult,
  RedmineThreadLookupInput,
  RedmineThreadV1
} from "@feedback/redmine-core";
import {
  RedmineFeedbackError,
  RedmineDiagnosticBuffer,
  diagnosticErrorCode,
  parseCurrentUserResult,
  parseProfileResult,
  parseThreadListResult,
  parseThreadResult,
  sha256Hex
} from "@feedback/redmine-core";
import { validateGatewayBasePath } from "./validation.js";

export type GatewayTransportOptions = {
  profileId: string;
  gatewayBasePath: string;
  fetch?: typeof globalThis.fetch;
  diagnostics?: RedmineDiagnosticBuffer;
};

type DiagnosticContext = { requestId: string; httpStatus: number | null };

export class GatewayRedmineFeedbackTransport implements RedmineFeedbackPort {
  readonly #profileId: string;
  readonly #basePath: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #diagnostics: RedmineDiagnosticBuffer | null;
  #maximumDownloadBytes = 52_428_800;
  #participant: Promise<RedmineParticipantV1> | null = null;
  #memoryParticipant: StoredParticipant | null = null;

  constructor(options: GatewayTransportOptions) {
    this.#profileId = options.profileId;
    this.#basePath = validateGatewayBasePath(options.gatewayBasePath);
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#diagnostics = options.diagnostics ?? null;
  }

  async getOrCreateParticipant(profileId: string, signal?: AbortSignalLike): Promise<RedmineParticipantV1> {
    this.#assertProfile(profileId);
    if (!this.#participant) this.#participant = this.#loadOrCreateParticipant(signal);
    try {
      return await this.#participant;
    } catch (error) {
      this.#participant = null;
      throw error;
    }
  }

  async getCapabilities(profileId: string, signal?: AbortSignalLike): Promise<RedmineProfileResult> {
    this.#assertProfile(profileId);
    return this.#diagnose("redmine.profile.get.v1", async (diagnostic) => {
      const result = parseProfileResult(await this.#json(`${this.#profilePath()}`, signal, diagnostic));
      this.#maximumDownloadBytes = result.profile.attachments.maximumDownloadBytes;
      return result;
    });
  }

  async getCurrentUser(profileId: string, signal?: AbortSignalLike): Promise<RedmineCurrentPrincipalV1> {
    this.#assertProfile(profileId);
    const participant = await this.getOrCreateParticipant(profileId, signal);
    return this.#diagnose("redmine.current-user.get.v1", async (diagnostic) =>
      parseCurrentUserResult(await this.#json(`${this.#profilePath()}/me`, signal, diagnostic, participant.credential)));
  }

  async listThreads(input: RedmineThreadListInput, signal?: AbortSignalLike): Promise<RedmineThreadListResult> {
    this.#assertProfile(input.profileId);
    const query = input.scope === "workspace" ? new URLSearchParams({ scope: "workspace" }) : resourceQuery(input.resourceRef);
    if (input.scope !== "workspace") query.set("pageKey", input.pageKey);
    query.set("sort", input.sort);
    if (input.filter?.status !== undefined) query.set("status", String(input.filter.status));
    if (input.filter?.perspectiveCode) query.set("perspectiveCode", input.filter.perspectiveCode);
    if (input.filter?.assigneeId) query.set("assigneeId", String(input.filter.assigneeId));
    if (input.filter?.priorityId) query.set("priorityId", String(input.filter.priorityId));
    if (input.filter?.q) query.set("q", input.filter.q);
    if (input.cursor) query.set("cursor", input.cursor);
    return this.#diagnose("redmine.thread.list.v1", async (diagnostic) =>
      parseThreadListResult(await this.#json(`${this.#profilePath()}/threads?${query}`, signal, diagnostic)));
  }

  async getThread(input: RedmineThreadLookupInput, signal?: AbortSignalLike): Promise<RedmineThreadV1> {
    this.#assertProfile(input.profileId);
    const participant = await this.getOrCreateParticipant(input.profileId, signal);
    return this.#diagnose("redmine.thread.get.v1", async (diagnostic) =>
      parseThreadResult(await this.#json(
        `${this.#profilePath()}/threads/${encodeURIComponent(input.threadId)}?${resourceQuery(input.resourceRef)}`,
        signal,
        diagnostic,
        participant.credential
      )));
  }

  async createThread(
    input: RedmineThreadCreateInput,
    evidenceBytes: Uint8Array | null,
    signal?: AbortSignalLike
  ): Promise<RedmineThreadV1> {
    this.#assertProfile(input.profileId);
    const participant = await this.getOrCreateParticipant(input.profileId, signal);
    const request = {
      resourceRef: input.resourceRef,
      threadId: input.threadId,
      intentId: input.intentId,
      comment: input.comment,
      perspectiveCode: input.perspectiveCode,
      location: input.location,
      target: input.target,
      release: input.release,
      locale: input.locale,
      threadUrl: input.threadUrl ?? null,
      capturedAt: input.capturedAt,
      evidence: input.evidence,
      participantName: input.participantName ?? null
    };
    const form = new FormData();
    form.append("request", new Blob([JSON.stringify(request)], { type: "application/json;charset=utf-8" }));
    if (evidenceBytes && input.evidence) {
      form.append("evidence", new Blob([Uint8Array.from(evidenceBytes).buffer], { type: input.evidence.contentType }), input.evidence.filename);
    }
    return this.#diagnose("redmine.thread.create.v1", async (diagnostic) => {
      const response = await this.#request(`${this.#profilePath()}/threads`, signal, {
        method: "POST",
        headers: {
          "Idempotency-Key": input.intentId
        },
        body: form
      }, diagnostic, participant.credential);
      return parseThreadResult(await parseJson(response));
    });
  }

  async createMessage(input: RedmineMessageCreateInput, signal?: AbortSignalLike): Promise<RedmineThreadV1> {
    this.#assertProfile(input.profileId);
    const participant = await this.getOrCreateParticipant(input.profileId, signal);
    return this.#diagnose("redmine.message.create.v1", async (diagnostic) => {
      const response = await this.#request(
        `${this.#profilePath()}/threads/${encodeURIComponent(input.threadId)}/messages`,
        signal,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": input.intentId },
          body: JSON.stringify({
            messageId: input.messageId,
            body: input.body,
            participantName: input.participantName
          })
        },
        diagnostic,
        participant.credential
      );
      return parseThreadResult(await parseJson(response));
    });
  }

  async updateMessage(input: RedmineMessageUpdateInput, signal?: AbortSignalLike): Promise<RedmineThreadV1> {
    this.#assertProfile(input.profileId);
    const participant = await this.getOrCreateParticipant(input.profileId, signal);
    return this.#diagnose("redmine.message.update.v1", async (diagnostic) => {
      const response = await this.#request(
        `${this.#profilePath()}/threads/${encodeURIComponent(input.threadId)}/messages/${encodeURIComponent(input.messageId)}`,
        signal,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "Idempotency-Key": input.intentId },
          body: JSON.stringify({
            body: input.body,
            expectedVersion: input.expectedVersion,
            participantName: input.participantName
          })
        },
        diagnostic,
        participant.credential
      );
      return parseThreadResult(await parseJson(response));
    });
  }

  async getAttachment(input: RedmineAttachmentInput, signal?: AbortSignalLike): Promise<RedmineAttachmentContent> {
    this.#assertProfile(input.profileId);
    return this.#diagnose("redmine.attachment.get.v1", async (diagnostic) => {
      const response = await this.#request(
        `${this.#profilePath()}/threads/${encodeURIComponent(input.threadId)}/attachments/${input.attachmentId}?${resourceQuery(input.resourceRef)}`,
        signal,
        {},
        diagnostic
      );
      const bytes = await limitedResponseBytes(response, this.#maximumDownloadBytes);
      const disposition = response.headers.get("content-disposition") ?? "";
      const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(disposition)?.[1];
      const plain = /filename="([^"]+)"/u.exec(disposition)?.[1];
      let filename: string;
      try {
        filename = sanitizeFilename(encoded ? decodeURIComponent(encoded) : plain ?? `attachment-${input.attachmentId}`);
      } catch {
        throw new RedmineFeedbackError("redmine.contract_invalid", "attachment filenameが不正です");
      }
      const declaredSha256 = response.headers.get("x-feedback-content-sha256") ?? "";
      if (!/^[a-f0-9]{64}$/u.test(declaredSha256) || await sha256Hex(bytes) !== declaredSha256) {
        throw new RedmineFeedbackError("redmine.contract_invalid", "attachment SHA-256が一致しません");
      }
      return {
        bytes,
        filename,
        contentType: response.headers.get("content-type")?.split(";", 1)[0] ?? "application/octet-stream",
        sha256: declaredSha256
      };
    });
  }

  async #json(
    path: string,
    signal: AbortSignalLike | undefined,
    diagnostic: DiagnosticContext,
    credential?: string
  ): Promise<unknown> {
    return parseJson(await this.#request(path, signal, {}, diagnostic, credential));
  }

  async #request(
    path: string,
    signal: AbortSignalLike | undefined,
    init: RequestInit,
    diagnostic: DiagnosticContext,
    credential?: string
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(path, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          ...(credential ? { "X-Feedback-Participant-Credential": credential } : {})
        },
        mode: "same-origin",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: signal as AbortSignal | undefined
      });
    } catch (cause) {
      throw new RedmineFeedbackError("redmine.unavailable", "gatewayへ接続できません", { retryable: true, cause });
    }
    diagnostic.httpStatus = response.status;
    if (!response.ok) throw await problem(response);
    return response;
  }

  async #diagnose<T>(operation: string, run: (diagnostic: DiagnosticContext) => Promise<T>): Promise<T> {
    const diagnostic = { requestId: crypto.randomUUID(), httpStatus: null as number | null };
    const started = performance.now();
    let errorCode: ReturnType<typeof diagnosticErrorCode> | null = null;
    try {
      return await run(diagnostic);
    } catch (error) {
      errorCode = diagnosticErrorCode(error);
      if (diagnostic.httpStatus === null && error instanceof RedmineFeedbackError) diagnostic.httpStatus = error.upstreamStatus;
      throw error;
    } finally {
      this.#diagnostics?.record({
        requestId: diagnostic.requestId,
        operation,
        profileId: this.#profileId,
        httpStatus: diagnostic.httpStatus,
        durationMilliseconds: performance.now() - started,
        errorCode
      });
    }
  }

  #profilePath(): string {
    return `${this.#basePath}/profiles/${encodeURIComponent(this.#profileId)}`;
  }

  #assertProfile(profileId: string): void {
    if (profileId !== this.#profileId) throw new Error("transport profile IDが一致しません");
  }

  async #loadOrCreateParticipant(signal?: AbortSignalLike): Promise<RedmineParticipantV1> {
    const key = participantStorageKey(this.#profileId);
    const stored = readParticipant(key) ?? this.#memoryParticipant;
    if (stored) return { participantId: stored.participantId, credential: stored.credential };
    const browserProfileId = crypto.randomUUID();
    const diagnostic = { requestId: crypto.randomUUID(), httpStatus: null as number | null };
    const response = await this.#request(`${this.#profilePath()}/participants`, signal, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browserProfileId })
    }, diagnostic);
    const participant = parseParticipant(await parseJson(response));
    const value = { browserProfileId, ...participant };
    this.#memoryParticipant = value;
    writeParticipant(key, value);
    return participant;
  }
}

type StoredParticipant = RedmineParticipantV1 & { browserProfileId: string };

function participantStorageKey(profileId: string): string {
  const origin = globalThis.location?.origin ?? "unknown-origin";
  return `feedback.redmine.participant.v1:${origin}:${profileId}`;
}

function readParticipant(key: string): StoredParticipant | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<StoredParticipant> | null;
    return value && validUuid(value.browserProfileId) && validUuid(value.participantId) &&
      typeof value.credential === "string" && value.credential.length >= 32 && value.credential.length <= 4096
      ? value as StoredParticipant : null;
  } catch {
    return null;
  }
}

function writeParticipant(key: string, value: StoredParticipant): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage拒否時はmemoryで継続する。 */ }
}

function parseParticipant(value: unknown): RedmineParticipantV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RedmineFeedbackError("redmine.contract_invalid", "participant responseが不正です");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => key !== "participantId" && key !== "credential") ||
    !validUuid(item.participantId) || typeof item.credential !== "string" ||
    item.credential.length < 32 || item.credential.length > 4096) {
    throw new RedmineFeedbackError("redmine.contract_invalid", "participant responseが不正です");
  }
  return { participantId: item.participantId, credential: item.credential };
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

async function limitedResponseBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new RedmineFeedbackError("redmine.payload_too_large", "attachmentがdownload上限を超えています");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      throw new RedmineFeedbackError("redmine.payload_too_large", "attachmentがdownload上限を超えています");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function sanitizeFilename(value: string): string {
  const segments = value.split(/[\\/]/u);
  const leaf = segments[segments.length - 1] ?? "attachment";
  const filename = Array.from(leaf.normalize("NFC").replace(/[\u0000-\u001f\u007f]/gu, "_").replace(/^\.+/u, "").trim())
    .slice(0, 200).join("");
  return filename || "attachment";
}

function resourceQuery(resource: { kind: string; key: string }): URLSearchParams {
  return new URLSearchParams({ resourceKind: resource.kind, resourceKey: resource.key });
}

async function parseJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") throw new RedmineFeedbackError("redmine.contract_invalid", "gateway response content typeが不正です");
  try {
    return await response.json();
  } catch (cause) {
    throw new RedmineFeedbackError("redmine.contract_invalid", "gateway JSON responseが不正です", { cause });
  }
}

async function problem(response: Response): Promise<RedmineFeedbackError> {
  try {
    const value = await response.json() as { error?: { code?: unknown; message?: unknown; retryable?: unknown; upstreamStatus?: unknown } };
    const error = value.error;
    if (error && typeof error.code === "string" && typeof error.message === "string" && typeof error.retryable === "boolean") {
      return new RedmineFeedbackError(error.code as RedmineFeedbackError["code"], error.message, {
        retryable: error.retryable,
        upstreamStatus: typeof error.upstreamStatus === "number" ? error.upstreamStatus : response.status
      });
    }
  } catch {
    // raw upstream bodyはUIへ渡さない。
  }
  return new RedmineFeedbackError("redmine.unavailable", "gatewayからFeedbackを取得できません", {
    retryable: response.status >= 500,
    upstreamStatus: response.status
  });
}
