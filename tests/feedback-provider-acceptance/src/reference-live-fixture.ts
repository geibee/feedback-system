// live検証runnerを外部writeなしで試すためのBacklog provider fixture。
import { BacklogConnectorProblem, type BacklogRequest, type BacklogTransport } from "@geibee/feedback-connector-backlog";

export class FakeBacklog implements BacklogTransport {
  issues: Array<Record<string, any>> = [];
  comments = new Map<number, Array<Record<string, any>>>();
  loseNextCreateResponse = false;
  loseNextCommentResponse = false;
  nextIssueId = 1;
  nextCommentId = 100;

  async request(request: BacklogRequest) {
    const path = new URL(request.path, "https://example.backlog.com");
    if (request.method === "GET" && path.pathname === "/api/v2/projects/1") return ok({ id: 1, projectKey: "FB", name: "Feedback", archived: false });
    if (request.method === "GET" && path.pathname === "/api/v2/issues") {
      const field = [...path.searchParams.keys()].find((name) => name.startsWith("customField_"));
      const id = Number(field?.slice("customField_".length));
      const value = field ? path.searchParams.get(field) : null;
      const offset = Number(path.searchParams.get("offset") ?? 0);
      const count = Number(path.searchParams.get("count") ?? 100);
      const matches = this.issues.filter((issue) => issue.customFields.some((item: any) => item.id === id && item.value === value));
      return ok(matches.slice(offset, offset + count));
    }
    if (request.method === "POST" && path.pathname === "/api/v2/issues") {
      const values = request.body!.values as Record<string, string>;
      const id = this.nextIssueId++;
      const now = "2026-09-02T00:00:00.000Z";
      const issue = {
        id, issueKey: `FB-${id}`, projectId: 1, summary: values.summary, description: values.description,
        customFields: Object.entries(values).flatMap(([name, value]) => name.startsWith("customField_") ? [{ id: Number(name.slice(12)), fieldTypeId: 1, name, value }] : []),
        status: { id: 1, name: "Open" }, created: now, updated: now, createdUser: { name: "Tester" }
      };
      this.issues.push(issue);
      if (this.loseNextCreateResponse) { this.loseNextCreateResponse = false; throw unknownWrite(); }
      return ok(issue);
    }
    const issueMatch = /^\/api\/v2\/issues\/(\d+)$/u.exec(path.pathname);
    if (issueMatch) {
      const issue = this.issues.find((value) => value.id === Number(issueMatch[1]));
      if (!issue) return response(404, null);
      if (request.method === "GET") return ok(issue);
      if (request.method === "PATCH") { issue.description = (request.body!.values as Record<string, string>).description; issue.updated = "2026-09-02T00:01:00.000Z"; return ok(issue); }
    }
    const commentsMatch = /^\/api\/v2\/issues\/(\d+)\/comments$/u.exec(path.pathname);
    if (commentsMatch) {
      const issueId = Number(commentsMatch[1]);
      const values = this.comments.get(issueId) ?? [];
      if (request.method === "GET") return ok(values);
      const id = this.nextCommentId++;
      const comment = { id, content: (request.body!.values as Record<string, string>).content, created: "2026-09-02T00:02:00.000Z", updated: "2026-09-02T00:02:00.000Z", createdUser: { name: "Tester" } };
      values.push(comment); this.comments.set(issueId, values);
      if (this.loseNextCommentResponse) { this.loseNextCommentResponse = false; throw unknownWrite(); }
      return ok(comment);
    }
    return response(404, null);
  }
}

function ok(body: unknown) { return response(200, body); }
function response(status: number, body: unknown) { return { status, headers: {}, body }; }
function unknownWrite() { return new BacklogConnectorProblem({ message: "unknown", status: 504, code: "feedback.provider_timeout", retryable: true, resultUnknown: true }); }
