import type { FeedbackAbortSignal } from "@geibee/feedback-connector-sdk";
import { BacklogConnectorProblem, type BacklogTransport } from "./types.js";

export type BacklogCustomFieldValue = { id: number; fieldTypeId: number; name: string; value: unknown };
export type BacklogIssue = {
  id: number;
  issueKey: string;
  projectId: number;
  summary: string;
  description: string;
  customFields: BacklogCustomFieldValue[];
  status: { id: number; name: string };
  created: string;
  updated: string;
  createdUser: { name: string } | null;
};
export type BacklogComment = {
  id: number;
  content: string;
  created: string;
  updated: string;
  createdUser: { name: string } | null;
};

/** Backlog API v2のform wireとDTO検証を閉じ込めるclient。 */
export class BacklogRestV2Client {
  constructor(readonly transport: BacklogTransport) {}

  async getProject(projectIdOrKey: string | number, signal?: FeedbackAbortSignal): Promise<{ id: number; projectKey: string; name: string; archived: boolean }> {
    const body = await this.json("GET", `/api/v2/projects/${segment(projectIdOrKey)}`, undefined, signal);
    const value = object(body, "Backlog project");
    return { id: integer(value.id, "project id"), projectKey: string(value.projectKey, "project key"), name: string(value.name, "project name"), archived: value.archived === true };
  }

  async getCustomFields(projectIdOrKey: string | number, signal?: FeedbackAbortSignal): Promise<readonly { id: number; typeId: number; name: string; required: boolean }[]> {
    const body = await this.json("GET", `/api/v2/projects/${segment(projectIdOrKey)}/customFields`, undefined, signal);
    return array(body, "Backlog custom fields").map((entry) => {
      const value = object(entry, "Backlog custom field");
      return { id: integer(value.id, "custom field id"), typeId: integer(value.typeId, "custom field type"), name: string(value.name, "custom field name"), required: value.required === true };
    });
  }

  async getIssueTypes(projectIdOrKey: string | number, signal?: FeedbackAbortSignal): Promise<readonly { id: number; name: string }[]> {
    const body = await this.json("GET", `/api/v2/projects/${segment(projectIdOrKey)}/issueTypes`, undefined, signal);
    return array(body, "Backlog issue types").map((entry) => {
      const value = object(entry, "Backlog issue type");
      return { id: integer(value.id, "issue type id"), name: string(value.name, "issue type name") };
    });
  }

  async getPriorities(signal?: FeedbackAbortSignal): Promise<readonly { id: number; name: string }[]> {
    const body = await this.json("GET", "/api/v2/priorities", undefined, signal);
    return array(body, "Backlog priorities").map((entry) => {
      const value = object(entry, "Backlog priority");
      return { id: integer(value.id, "priority id"), name: string(value.name, "priority name") };
    });
  }

  async searchIssues(input: {
    projectId: number;
    customFieldId: number;
    customFieldValue: string;
    offset: number;
    count: number;
    order: "asc" | "desc";
    signal?: FeedbackAbortSignal;
  }): Promise<BacklogIssue[]> {
    const query = new URLSearchParams();
    query.append("projectId[]", String(input.projectId));
    query.set(`customField_${input.customFieldId}`, input.customFieldValue);
    query.set("sort", "updated");
    query.set("order", input.order);
    query.set("offset", String(input.offset));
    query.set("count", String(input.count));
    const body = await this.json("GET", `/api/v2/issues?${query.toString()}`, undefined, input.signal);
    const issues = array(body, "Backlog issue list").map(mapIssue);
    if (issues.length > input.count) throw invalidPayload("issue page size");
    return issues;
  }

  async getIssue(issueIdOrKey: string | number, signal?: FeedbackAbortSignal): Promise<BacklogIssue> {
    return mapIssue(await this.json("GET", `/api/v2/issues/${segment(issueIdOrKey)}`, undefined, signal));
  }

  async createIssue(input: {
    projectId: number;
    summary: string;
    description: string;
    issueTypeId: number;
    priorityId: number;
    customFields: Readonly<Record<number, string>>;
    signal?: FeedbackAbortSignal;
  }): Promise<BacklogIssue> {
    const values: Record<string, string> = {
      projectId: String(input.projectId),
      summary: input.summary,
      description: input.description,
      issueTypeId: String(input.issueTypeId),
      priorityId: String(input.priorityId)
    };
    for (const [id, value] of Object.entries(input.customFields)) values[`customField_${id}`] = value;
    return mapIssue(await this.json("POST", "/api/v2/issues", values, input.signal));
  }

  async updateIssueDescription(issueIdOrKey: string | number, description: string, signal?: FeedbackAbortSignal): Promise<BacklogIssue> {
    return mapIssue(await this.json("PATCH", `/api/v2/issues/${segment(issueIdOrKey)}`, { description }, signal));
  }

  async getAllComments(issueIdOrKey: string | number, pageSize: number, signal?: FeedbackAbortSignal): Promise<BacklogComment[]> {
    const result: BacklogComment[] = [];
    let minId: number | undefined;
    for (;;) {
      const query = new URLSearchParams({ count: String(pageSize), order: "asc" });
      if (minId !== undefined) query.set("minId", String(minId));
      const body = await this.json("GET", `/api/v2/issues/${segment(issueIdOrKey)}/comments?${query.toString()}`, undefined, signal);
      const page = array(body, "Backlog comments").map(mapComment);
      const before = result.length;
      for (const comment of page) if (!result.some((value) => value.id === comment.id)) result.push(comment);
      if (page.length < pageSize) return result;
      minId = page.at(-1)?.id;
      if (minId === undefined || result.length === before || result.length > 10_000) throw invalidPayload("comment pagination");
    }
  }

  async addComment(issueIdOrKey: string | number, content: string, signal?: FeedbackAbortSignal): Promise<BacklogComment> {
    return mapComment(await this.json("POST", `/api/v2/issues/${segment(issueIdOrKey)}/comments`, { content }, signal));
  }

  private async json(method: "GET" | "POST" | "PATCH", path: string, values?: Record<string, string>, signal?: FeedbackAbortSignal): Promise<unknown> {
    const response = await this.transport.request({ method, path, ...(values ? { body: { kind: "form", values } } : {}), signal });
    if (response.status >= 200 && response.status < 300) return response.body;
    throw mapStatus(response.status, response.headers, method !== "GET");
  }
}

function mapIssue(input: unknown): BacklogIssue {
  const value = object(input, "Backlog issue");
  const status = object(value.status, "Backlog issue status");
  return {
    id: integer(value.id, "issue id"),
    issueKey: string(value.issueKey, "issue key"),
    projectId: integer(value.projectId, "issue projectId"),
    summary: string(value.summary, "issue summary"),
    description: nullableString(value.description, "issue description"),
    customFields: array(value.customFields, "issue customFields").map((entry) => {
      const field = object(entry, "issue custom field");
      return {
        id: integer(field.id, "custom field id"),
        fieldTypeId: integer(field.fieldTypeId, "custom field type"),
        name: string(field.name, "custom field name"),
        value: field.value
      };
    }),
    status: { id: integer(status.id, "status id"), name: string(status.name, "status name") },
    created: date(value.created, "issue created"),
    updated: date(value.updated, "issue updated"),
    createdUser: mapUser(value.createdUser)
  };
}

function mapComment(input: unknown): BacklogComment {
  const value = object(input, "Backlog comment");
  return {
    id: integer(value.id, "comment id"),
    content: nullableString(value.content, "comment content"),
    created: date(value.created, "comment created"),
    updated: date(value.updated, "comment updated"),
    createdUser: mapUser(value.createdUser)
  };
}

function mapUser(input: unknown): { name: string } | null {
  if (input === null) return null;
  const value = object(input, "Backlog user");
  return { name: string(value.name, "user name") };
}

function mapStatus(status: number, headers: Readonly<Record<string, string>>, resultUnknown: boolean): BacklogConnectorProblem {
  if (status === 400) return problem("Backlog requestが不正です", 400, "feedback.invalid_request", false);
  if (status === 401 || status === 403) return problem("Backlog操作が許可されていません", 403, "feedback.forbidden", false);
  if (status === 404) return problem("Backlog objectがありません", 404, "feedback.not_found", false);
  if (status === 409) return problem("Backlog更新が競合しました", 409, "feedback.conflict", false);
  if (status === 429) {
    const retryAfterSeconds = retryAfter(headers);
    return new BacklogConnectorProblem({ message: "Backlog rate limitです", status: 429, code: "feedback.rate_limited", retryable: true, ...(retryAfterSeconds ? { retryAfterSeconds } : {}), resultUnknown });
  }
  return new BacklogConnectorProblem({ message: "Backlog provider errorです", status: 502, code: "feedback.provider_unavailable", retryable: status >= 500, resultUnknown });
}

function retryAfter(headers: Readonly<Record<string, string>>): number | undefined {
  const direct = headers["retry-after"];
  if (direct && /^[0-9]+$/u.test(direct)) return Math.min(Number(direct), 300);
  const reset = headers["x-ratelimit-reset"];
  if (reset && /^[0-9]+$/u.test(reset)) return Math.min(Math.max(Math.ceil(Number(reset) - Date.now() / 1000), 1), 300);
  return undefined;
}

function problem(message: string, status: number, code: BacklogConnectorProblem["code"], retryable: boolean): BacklogConnectorProblem {
  return new BacklogConnectorProblem({ message, status, code, retryable });
}

function invalidPayload(name: string): BacklogConnectorProblem {
  return new BacklogConnectorProblem({ message: `Backlog provider payloadが不正です: ${name}`, status: 502, code: "feedback.provider_unavailable", retryable: false });
}

function segment(value: string | number): string { return encodeURIComponent(String(value)); }
function object(value: unknown, name: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidPayload(name); return value as Record<string, unknown>; }
function array(value: unknown, name: string): unknown[] { if (!Array.isArray(value)) throw invalidPayload(name); return value; }
function string(value: unknown, name: string): string { if (typeof value !== "string" || value.length === 0) throw invalidPayload(name); return value; }
function nullableString(value: unknown, name: string): string { if (value === null) return ""; if (typeof value !== "string") throw invalidPayload(name); return value; }
function integer(value: unknown, name: string): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw invalidPayload(name); return Number(value); }
function date(value: unknown, name: string): string { const result = string(value, name); if (!Number.isFinite(Date.parse(result))) throw invalidPayload(name); return result; }
