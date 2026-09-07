import type { FeedbackAbortSignal, FeedbackUploadStreamSource } from "@geibee/feedback-connector-sdk";
import {
  JiraCloudConnectorProblem,
  type JiraCloudResponse,
  type JiraCloudTransport
} from "./types.js";

export type JiraCloudIssue = {
  id: string;
  key: string;
  fields: Record<string, unknown>;
  properties?: Record<string, unknown>;
};

export type JiraCloudComment = {
  id: string;
  body: unknown;
  created: string;
  updated?: string;
  author?: unknown;
  properties?: readonly unknown[];
};

export type JiraCloudAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  created: string;
};

export type JiraCloudSearchPage = {
  issues: JiraCloudIssue[];
  nextPageToken: string | null;
  isLast: boolean;
};

export type JiraCloudCommentPage = {
  comments: JiraCloudComment[];
  startAt: number;
  maxResults: number;
  total: number;
};

/** Jira Cloud REST API v3のendpointとprovider error正規化を閉じ込めるclient。 */
export class JiraCloudRestV3Client {
  readonly transport: JiraCloudTransport;

  constructor(transport: JiraCloudTransport) {
    this.transport = transport;
  }

  async searchIssues(input: {
    jql: string;
    maxResults: number;
    nextPageToken?: string;
    fields?: readonly string[];
    properties?: readonly string[];
    signal?: FeedbackAbortSignal;
  }): Promise<JiraCloudSearchPage> {
    const body = await this.json("POST", "/rest/api/3/search/jql", {
      jql: input.jql,
      maxResults: input.maxResults,
      ...(input.nextPageToken ? { nextPageToken: input.nextPageToken } : {}),
      ...(input.fields ? { fields: input.fields } : {}),
      ...(input.properties ? { properties: input.properties } : {})
    }, input.signal);
    const object = requiredObject(body, "Jira search response");
    const issues = requiredArray(object.issues, "Jira search issues").map(mapIssue);
    if (issues.length > input.maxResults) throw invalidProviderPayload("Jira search page size");
    const nextPageToken = optionalString(object.nextPageToken);
    if (nextPageToken && nextPageToken.length > 2048) throw invalidProviderPayload("Jira search nextPageToken");
    return {
      issues,
      nextPageToken,
      isLast: object.isLast === true || !nextPageToken
    };
  }

  async createIssue(input: { fields: Record<string, unknown>; properties: readonly unknown[]; signal?: FeedbackAbortSignal }): Promise<{ id: string; key: string }> {
    const body = await this.json("POST", "/rest/api/3/issue?returnIssue=true", {
      fields: input.fields,
      properties: input.properties
    }, input.signal);
    const object = requiredObject(body, "Jira create issue response");
    return { id: requiredString(object.id, "issue id"), key: requiredString(object.key, "issue key") };
  }

  async getIssue(issueId: string, signal?: FeedbackAbortSignal): Promise<JiraCloudIssue> {
    const fields = "summary,status,created,updated,description,attachment";
    const body = await this.json("GET", `/rest/api/3/issue/${segment(issueId)}?fields=${fields}`, undefined, signal);
    return mapIssue(body);
  }

  async getIssueProperty(issueId: string, propertyKey: string, signal?: FeedbackAbortSignal): Promise<unknown> {
    const body = await this.json("GET", `/rest/api/3/issue/${segment(issueId)}/properties/${segment(propertyKey)}`, undefined, signal);
    return requiredObject(body, "Jira issue property response").value;
  }

  async setIssueProperty(issueId: string, propertyKey: string, value: unknown, signal?: FeedbackAbortSignal): Promise<void> {
    await this.empty("PUT", `/rest/api/3/issue/${segment(issueId)}/properties/${segment(propertyKey)}`, value, signal);
  }

  async listIssueProperties(issueId: string, signal?: FeedbackAbortSignal): Promise<readonly string[]> {
    const body = await this.json("GET", `/rest/api/3/issue/${segment(issueId)}/properties`, undefined, signal);
    const keys = requiredArray(requiredObject(body, "Jira issue properties response").keys, "Jira issue properties keys");
    return keys.map((item) => requiredString(requiredObject(item, "Jira property key").key, "Jira property key value"));
  }

  async getCommentsPage(input: { issueId: string; startAt: number; maxResults: number; signal?: FeedbackAbortSignal }): Promise<JiraCloudCommentPage> {
    const path = `/rest/api/3/issue/${segment(input.issueId)}/comment?startAt=${input.startAt}&maxResults=${input.maxResults}&expand=properties`;
    const body = await this.json("GET", path, undefined, input.signal);
    const object = requiredObject(body, "Jira comments response");
    const page = {
      comments: requiredArray(object.comments, "Jira comments").map(mapComment),
      startAt: requiredInteger(object.startAt, "Jira comments startAt"),
      maxResults: requiredInteger(object.maxResults, "Jira comments maxResults"),
      total: requiredInteger(object.total, "Jira comments total")
    };
    if (page.startAt !== input.startAt || page.comments.length > input.maxResults || page.maxResults > input.maxResults) {
      throw invalidProviderPayload("Jira comments pagination boundary");
    }
    return page;
  }

  async getAllComments(issueId: string, pageSize: number, signal?: FeedbackAbortSignal): Promise<JiraCloudComment[]> {
    const comments: JiraCloudComment[] = [];
    let startAt = 0;
    for (;;) {
      const page = await this.getCommentsPage({ issueId, startAt, maxResults: pageSize, signal });
      comments.push(...page.comments);
      const next = page.startAt + page.comments.length;
      if (next >= page.total || page.comments.length === 0) return comments;
      startAt = next;
    }
  }

  async getCommentProperty(issueId: string, commentId: string, propertyKey: string, signal?: FeedbackAbortSignal): Promise<unknown> {
    // REST v3のcomment propertyはissue配下ではない。issueIdは既存client APIと呼び出しscopeの互換のため維持する。
    segment(issueId);
    const path = `/rest/api/3/comment/${segment(commentId)}/properties/${segment(propertyKey)}`;
    const body = await this.json("GET", path, undefined, signal);
    return requiredObject(body, "Jira comment property response").value;
  }

  async createComment(input: { issueId: string; body: unknown; property: { key: string; value: unknown }; signal?: FeedbackAbortSignal }): Promise<JiraCloudComment> {
    const path = `/rest/api/3/issue/${segment(input.issueId)}/comment`;
    const body = await this.json("POST", path, {
      body: input.body,
      properties: [input.property]
    }, input.signal);
    return mapComment(body);
  }

  async uploadAttachment(input: {
    issueId: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    source: FeedbackUploadStreamSource;
    signal?: FeedbackAbortSignal;
  }): Promise<JiraCloudAttachment> {
    const response = await this.transport.request({
      method: "POST",
      path: `/rest/api/3/issue/${segment(input.issueId)}/attachments`,
      headers: { "X-Atlassian-Token": "no-check" },
      body: {
        kind: "multipart-file",
        fieldName: "file",
        filename: input.filename,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        content: input.source.read()
      },
      signal: input.signal
    });
    const body = this.accept(response, "POST");
    const attachments = requiredArray(body, "Jira attachment upload response").map(mapAttachment);
    if (attachments.length !== 1) {
      throw new JiraCloudConnectorProblem({
        message: "Jira attachment uploadが単一resultを返しませんでした",
        status: 502,
        code: "feedback.provider_unavailable",
        retryable: false,
        resultUnknown: true
      });
    }
    return attachments[0]!;
  }

  async getAttachmentMetadata(attachmentId: string, signal?: FeedbackAbortSignal): Promise<JiraCloudAttachment> {
    const body = await this.json("GET", `/rest/api/3/attachment/${segment(attachmentId)}`, undefined, signal);
    return mapAttachment(body);
  }

  async downloadAttachment(attachmentId: string, signal?: FeedbackAbortSignal): Promise<{ headers: Readonly<Record<string, string>>; body: AsyncIterable<Uint8Array> }> {
    const response = await this.transport.request({
      method: "GET",
      path: `/rest/api/3/attachment/content/${segment(attachmentId)}`,
      responseMode: "stream",
      signal
    });
    this.accept(response, "GET");
    if (!response.stream) {
      throw new JiraCloudConnectorProblem({
        message: "Jira attachment download bodyがありません",
        status: 502,
        code: "feedback.provider_unavailable",
        retryable: true
      });
    }
    return { headers: response.headers, body: response.stream };
  }

  async listProjects(input: { startAt: number; maxResults: number; signal?: FeedbackAbortSignal }): Promise<{ values: readonly { id: string; key: string; name: string }[]; total: number }> {
    const body = await this.json("GET", `/rest/api/3/project/search?startAt=${input.startAt}&maxResults=${input.maxResults}&orderBy=key`, undefined, input.signal);
    const object = requiredObject(body, "Jira project search response");
    const values = requiredArray(object.values, "Jira projects").map((item) => {
        const project = requiredObject(item, "Jira project");
        return { id: requiredString(project.id, "project id"), key: requiredString(project.key, "project key"), name: requiredString(project.name, "project name") };
      });
    if (values.length > input.maxResults) throw invalidProviderPayload("Jira projects page size");
    return { values, total: requiredInteger(object.total, "Jira projects total") };
  }

  async listComponents(input: { projectKey: string; startAt: number; maxResults: number; signal?: FeedbackAbortSignal }): Promise<{ values: readonly { id: string; name: string }[]; total: number }> {
    const path = `/rest/api/3/project/${segment(input.projectKey)}/components?startAt=${input.startAt}&maxResults=${input.maxResults}`;
    const body = await this.json("GET", path, undefined, input.signal);
    const object = requiredObject(body, "Jira components response");
    const values = requiredArray(object.values, "Jira components").map((item) => {
        const component = requiredObject(item, "Jira component");
        return { id: requiredString(component.id, "component id"), name: requiredString(component.name, "component name") };
      });
    if (values.length > input.maxResults) throw invalidProviderPayload("Jira components page size");
    return { values, total: requiredInteger(object.total, "Jira components total") };
  }

  private async json(method: "GET" | "POST" | "PUT", path: string, body?: unknown, signal?: FeedbackAbortSignal): Promise<unknown> {
    const response = await this.transport.request({
      method,
      path,
      ...(body === undefined ? {} : { body: { kind: "json", value: body } as const }),
      signal
    });
    return this.accept(response, method);
  }

  private async empty(method: "POST" | "PUT", path: string, body: unknown, signal?: FeedbackAbortSignal): Promise<void> {
    const response = await this.transport.request({ method, path, body: { kind: "json", value: body }, signal });
    this.accept(response, method);
  }

  private accept(response: JiraCloudResponse, method: "GET" | "POST" | "PUT"): unknown {
    if (response.status >= 200 && response.status < 300) return response.body;
    throw normalizeJiraCloudResponse(response, method !== "GET");
  }
}

export function normalizeJiraCloudResponse(response: JiraCloudResponse, resultUnknown: boolean): JiraCloudConnectorProblem {
  const retryAfterSeconds = parseRetryAfter(response.headers["retry-after"]);
  switch (response.status) {
    case 400:
      return problem(400, "feedback.invalid_request", false, "Jira Cloud requestが不正です");
    case 401:
    case 403:
      return problem(403, "feedback.forbidden", false, "Jira Cloudが操作を拒否しました");
    case 404:
      return problem(404, "feedback.not_found", false, "Jira Cloud objectがありません");
    case 409:
      return problem(409, "feedback.conflict", false, "Jira Cloudで競合しました");
    case 413:
      return problem(413, "feedback.payload_too_large", false, "Jira Cloud payload上限を超えました");
    case 415:
      return problem(415, "feedback.unsupported_media_type", false, "Jira Cloudがmedia typeを受け付けません");
    case 429:
      return problem(429, "feedback.rate_limited", true, "Jira Cloud rate limitに達しました", retryAfterSeconds, resultUnknown);
    default:
      if (response.status >= 500 && response.status <= 599) {
        return problem(502, "feedback.provider_unavailable", true, "Jira Cloudが利用できません", retryAfterSeconds, resultUnknown);
      }
      return problem(502, "feedback.provider_unavailable", false, `Jira Cloudから予期しないstatus ${response.status}を受けました`, undefined, resultUnknown);
  }
}

function problem(
  status: number,
  code: JiraCloudConnectorProblem["code"],
  retryable: boolean,
  message: string,
  retryAfterSeconds?: number,
  resultUnknown = false
): JiraCloudConnectorProblem {
  return new JiraCloudConnectorProblem({ status, code, retryable, message, retryAfterSeconds, resultUnknown });
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : undefined;
}

function mapIssue(value: unknown): JiraCloudIssue {
  const object = requiredObject(value, "Jira issue");
  return {
    id: requiredString(object.id, "issue id"),
    key: requiredString(object.key, "issue key"),
    fields: isObject(object.fields) ? object.fields : {},
    ...(isObject(object.properties) ? { properties: object.properties } : {})
  };
}

function mapComment(value: unknown): JiraCloudComment {
  const object = requiredObject(value, "Jira comment");
  return {
    id: requiredString(object.id, "comment id"),
    body: object.body,
    created: requiredString(object.created, "comment created"),
    ...(typeof object.updated === "string" ? { updated: object.updated } : {}),
    ...(object.author !== undefined ? { author: object.author } : {}),
    ...(Array.isArray(object.properties) ? { properties: object.properties } : {})
  };
}

function mapAttachment(value: unknown): JiraCloudAttachment {
  const object = requiredObject(value, "Jira attachment");
  return {
    id: requiredIdentifier(object.id, "attachment id"),
    filename: requiredString(object.filename, "attachment filename"),
    mimeType: requiredString(object.mimeType, "attachment mimeType"),
    size: requiredInteger(object.size, "attachment size"),
    created: normalizedDateTime(object.created, "attachment created")
  };
}

function requiredIdentifier(value: unknown, label: string): string {
  if (typeof value === "string" && value.length > 0 && value.length <= 512) return value;
  if (Number.isSafeInteger(value) && Number(value) > 0) return String(value);
  throw invalidProviderPayload(label);
}

function normalizedDateTime(value: unknown, label: string): string {
  const source = requiredString(value, label);
  const normalizedOffset = source.replace(/([+-]\d{2})(\d{2})$/u, "$1:$2");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(normalizedOffset)) {
    throw invalidProviderPayload(label);
  }
  const milliseconds = Date.parse(normalizedOffset);
  if (!Number.isFinite(milliseconds)) throw invalidProviderPayload(label);
  return new Date(milliseconds).toISOString();
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw invalidProviderPayload(label);
  return value;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw invalidProviderPayload(label);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalidProviderPayload(label);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw invalidProviderPayload(label);
  return Number(value);
}

function invalidProviderPayload(label: string): JiraCloudConnectorProblem {
  return new JiraCloudConnectorProblem({
    message: `${label}が契約と一致しません`,
    status: 502,
    code: "feedback.provider_unavailable",
    retryable: false
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function segment(value: string): string {
  if (value.length === 0 || value.length > 512) throw new Error("Jira Cloud path segmentが不正です");
  return encodeURIComponent(value);
}
