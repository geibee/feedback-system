import { createHash } from "node:crypto";
import {
  FeedbackConnectorProblem,
  type FeedbackAbortSignal,
  type FeedbackDownloadStream,
  type FeedbackUploadStreamSource
} from "@geibee/feedback-connector-sdk";
import type {
  FeedbackRedmineTransportPort,
  RedmineIssueInput,
  RedmineIssueRaw,
  RedmineIssueSearchPage,
  RedmineIssueUpdate,
  RedmineUploadReceipt
} from "./redmine-types.js";

export type RedmineFetchResponse = {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
};

export type RedmineFetch = (url: string, init: {
  method: "GET" | "POST" | "PUT";
  headers: Readonly<Record<string, string>>;
  body?: string | Uint8Array;
  signal?: FeedbackAbortSignal;
}) => Promise<RedmineFetchResponse>;

export function createFeedbackRedmineRestTransport(input: {
  baseUrl: string;
  apiKey: string;
  fetch: RedmineFetch;
}): FeedbackRedmineTransportPort {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (!input.apiKey) throw new Error("Redmine API credentialが空です");
  const authorization = Object.freeze({ "X-Redmine-API-Key": input.apiKey });

  const json = async (
    method: "GET" | "POST" | "PUT",
    path: string,
    body: unknown | undefined,
    signal?: FeedbackAbortSignal
  ): Promise<unknown> => {
    aborted(signal);
    let response: RedmineFetchResponse;
    try {
      response = await input.fetch(`${baseUrl}${path}`, {
        method,
        headers: { ...authorization, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {})
      });
    } catch (error) {
      throw providerUnavailable(error);
    }
    if (!response.ok) throw await providerProblem(response);
    if (response.status === 204) return null;
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") throw integrity("Redmine JSON responseのcontent typeが不正です");
    try { return await response.json(); } catch (error) { throw integrity("Redmine JSON responseを解析できません", error); }
  };

  const transport: FeedbackRedmineTransportPort = {
    async searchIssues(query, signal) {
      const parameters = new URLSearchParams({
        project_id: String(query.projectId),
        status_id: "*",
        offset: String(query.offset),
        limit: String(query.limit),
        sort: query.order === "updated_desc" ? "updated_on:desc,id:desc" : "updated_on:asc,id:asc"
      });
      for (const [id, value] of Object.entries(query.customFieldFilters)) parameters.set(`cf_${id}`, value);
      const root = object(await json("GET", `issues.json?${parameters}`, undefined, signal), "issue search");
      return {
        issues: array(root.issues, "issues") as RedmineIssueSearchPage["issues"],
        totalCount: integer(root.total_count, "total_count", true),
        offset: integer(root.offset, "offset", true),
        limit: integer(root.limit, "limit")
      };
    },

    async getIssue(issueId, signal) {
      const root = object(await json("GET", `issues/${positiveId(issueId)}.json?include=journals,attachments`, undefined, signal), "issue detail");
      return object(root.issue, "issue") as RedmineIssueRaw;
    },

    async createIssue(issue, signal) {
      const root = object(await json("POST", "issues.json", { issue: validateIssueInput(issue) }, signal), "issue create");
      return { issueId: integer(object(root.issue, "issue").id, "issue.id") };
    },

    async updateIssue(issueId, issue, signal) {
      await json("PUT", `issues/${positiveId(issueId)}.json`, { issue: validateIssueUpdate(issue) }, signal);
    },

    async upload(source, metadata, signal): Promise<RedmineUploadReceipt> {
      aborted(signal);
      const bytes = await collect(source, signal);
      const actualHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (actualHash !== metadata.contentHash) {
        throw new FeedbackConnectorProblem({ code: "feedback.integrity_error", status: 400, retryable: false, message: "attachment stream hashがcommandと一致しません" });
      }
      let response: RedmineFetchResponse;
      try {
        response = await input.fetch(`${baseUrl}uploads.json?filename=${encodeURIComponent(metadata.filename)}`, {
          method: "POST",
          headers: { ...authorization, Accept: "application/json", "Content-Type": "application/octet-stream" },
          body: bytes,
          ...(signal ? { signal } : {})
        });
      } catch (error) {
        throw providerUnavailable(error);
      }
      if (!response.ok) throw await providerProblem(response);
      const root = object(await response.json(), "upload response");
      const token = object(root.upload, "upload").token;
      if (typeof token !== "string" || !token) throw integrity("Redmine upload tokenがありません");
      return { token };
    },

    async downloadAttachment(providerAttachmentId, signal): Promise<FeedbackDownloadStream> {
      if (!/^[1-9][0-9]*$/u.test(providerAttachmentId)) throw integrity("Redmine attachment IDが不正です");
      const root = object(await json("GET", `attachments/${providerAttachmentId}.json`, undefined, signal), "attachment metadata");
      const attachment = object(root.attachment, "attachment");
      const contentUrl = sameOriginContentUrl(baseUrl, string(attachment.content_url, "attachment.content_url"));
      let response: RedmineFetchResponse;
      try {
        response = await input.fetch(contentUrl, { method: "GET", headers: authorization, ...(signal ? { signal } : {}) });
      } catch (error) {
        throw providerUnavailable(error);
      }
      if (!response.ok) throw await providerProblem(response);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const expected = integer(attachment.filesize, "attachment.filesize", true);
      if (bytes.byteLength !== expected) throw integrity("Redmine attachment sizeがmetadataと一致しません");
      return {
        filename: string(attachment.filename, "attachment.filename"),
        contentType: typeof attachment.content_type === "string" && attachment.content_type
          ? attachment.content_type : "application/octet-stream",
        sizeBytes: bytes.byteLength,
        body: (async function* () { yield bytes; })()
      };
    }
  };
  return Object.freeze(transport);
}

async function collect(source: FeedbackUploadStreamSource, signal?: FeedbackAbortSignal): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source.read()) {
    aborted(signal);
    if (!(chunk instanceof Uint8Array)) throw integrity("attachment sourceがUint8Arrayではありません");
    length += chunk.byteLength;
    if (length > source.sizeBytes) throw integrity("attachment sourceが宣言sizeを超えました");
    chunks.push(Uint8Array.from(chunk));
  }
  if (length !== source.sizeBytes) throw integrity("attachment source sizeが宣言値と一致しません");
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function validateIssueInput(issue: RedmineIssueInput): RedmineIssueInput {
  positiveId(issue.project_id);
  positiveId(issue.tracker_id);
  if (!issue.subject.trim() || !issue.description.trim()) throw integrity("Redmine issue title/bodyが空です");
  issue.custom_fields.forEach(validateCustomField);
  return issue;
}

function validateIssueUpdate(issue: RedmineIssueUpdate): RedmineIssueUpdate {
  issue.custom_fields?.forEach(validateCustomField);
  if (issue.notes !== undefined && !issue.notes.trim()) throw integrity("Redmine journal notesが空です");
  for (const upload of issue.uploads ?? []) {
    if (!upload.token || !upload.filename || !upload.content_type) throw integrity("Redmine upload associationが不正です");
  }
  return issue;
}

function validateCustomField(field: { id: number; value: unknown }): void {
  positiveId(field.id);
  if (typeof field.value !== "string") throw integrity("Redmine custom field valueがstringではありません");
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Redmine base URLが不正です"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Redmine base URLはcredentialなしのHTTPS URLである必要があります");
  }
  return `${url.origin}${url.pathname.replace(/\/?$/u, "/")}`;
}

function sameOriginContentUrl(base: string, value: string): string {
  let baseUrl: URL;
  let url: URL;
  try { baseUrl = new URL(base); url = new URL(value, base); } catch { throw integrity("Redmine attachment content URLが不正です"); }
  if (url.origin !== baseUrl.origin || url.username || url.password || url.search || url.hash ||
    !url.pathname.startsWith(baseUrl.pathname)) throw integrity("Redmine attachment content URLがprofile origin外です");
  return url.toString();
}

async function providerProblem(response: RedmineFetchResponse): Promise<FeedbackConnectorProblem> {
  const retryAfter = Number(response.headers.get("retry-after"));
  const input = response.status === 429
    ? { code: "feedback.rate_limited" as const, status: 429, retryable: true }
    : response.status === 408 || response.status === 504
      ? { code: "feedback.provider_timeout" as const, status: 504, retryable: true }
      : response.status >= 500
        ? { code: "feedback.provider_unavailable" as const, status: 502, retryable: true }
        : response.status === 409
          ? { code: "feedback.conflict" as const, status: 409, retryable: false }
          : { code: "feedback.unsupported" as const, status: response.status, retryable: false };
  return new FeedbackConnectorProblem({
    ...input,
    message: `Redmine REST error: ${response.status}`,
    ...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfterSeconds: retryAfter } : {})
  });
}

function providerUnavailable(cause: unknown): FeedbackConnectorProblem {
  return new FeedbackConnectorProblem({
    code: "feedback.provider_unavailable",
    status: 502,
    retryable: true,
    message: cause instanceof Error ? `Redmineへ接続できません: ${cause.message}` : "Redmineへ接続できません"
  });
}

function integrity(message: string, cause?: unknown): FeedbackConnectorProblem {
  return new FeedbackConnectorProblem({
    code: "feedback.integrity_error",
    status: 502,
    retryable: false,
    message: cause instanceof Error ? `${message}: ${cause.message}` : message
  });
}

function aborted(signal?: FeedbackAbortSignal): void {
  if (signal?.aborted) throw new FeedbackConnectorProblem({ code: "feedback.provider_timeout", status: 504, retryable: true, message: "Redmine requestが中断されました" });
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw integrity(`${name}がobjectではありません`);
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw integrity(`${name}がarrayではありません`);
  return value;
}

function integer(value: unknown, name: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) throw integrity(`${name}が整数ではありません`);
  return Number(value);
}

function positiveId(value: number): number {
  return integer(value, "provider ID");
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw integrity(`${name}がstringではありません`);
  return value;
}
