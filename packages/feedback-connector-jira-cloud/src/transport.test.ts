import { describe, expect, it } from "vitest";
import { createJiraCloudFetchTransport } from "./http-transport.js";
import { JiraCloudRestV3Client, normalizeJiraCloudResponse } from "./rest-v3-client.js";
import { JiraCloudRequestCancelledError, type JiraCloudFetchResponse } from "./types.js";

function headers(values: Record<string, string> = {}) {
  return {
    get(name: string) { return values[name.toLowerCase()] ?? null; },
    forEach(callback: (value: string, key: string) => void) { for (const [key, value] of Object.entries(values)) callback(value, key); }
  };
}

function response(status: number, body: unknown, responseHeaders: Record<string, string> = { "content-type": "application/json" }): JiraCloudFetchResponse {
  return {
    status,
    headers: headers(responseHeaders),
    async json() { return body; },
    async text() { return typeof body === "string" ? body : JSON.stringify(body); },
    body: null
  };
}

describe("Jira Cloud HTTP transport", () => {
  it("HTTPS origin以外とuserinfo付きbase URLを拒否する", () => {
    const base = { authorization: "Bearer test-only", timeoutMilliseconds: 1_000, fetch: async () => response(200, {}) };
    expect(() => createJiraCloudFetchTransport({ ...base, baseUrl: "http://example.atlassian.net" })).toThrow(/HTTPS origin/);
    expect(() => createJiraCloudFetchTransport({ ...base, baseUrl: "https://user:secret@example.atlassian.net" })).toThrow(/host/);
    expect(() => createJiraCloudFetchTransport({ ...base, baseUrl: "https://example.atlassian.net/path" })).toThrow(/HTTPS origin/);
  });

  it("multipartをstreamingし、Content-Lengthとno-checkを付けて一回だけ送る", async () => {
    let calls = 0;
    let receivedBytes = 0;
    let sentHeaders: Readonly<Record<string, string>> = {};
    const transport = createJiraCloudFetchTransport({
      baseUrl: "https://example.atlassian.net/",
      authorization: "Bearer test-only",
      timeoutMilliseconds: 1_000,
      createBoundary: () => "feedback-test-boundary-1234",
      fetch: async (_url, init) => {
        calls += 1;
        sentHeaders = init.headers;
        if (typeof init.body !== "string" && init.body) for await (const chunk of init.body) receivedBytes += chunk.byteLength;
        return response(201, [{ id: "30001", filename: "a.txt", mimeType: "text/plain", size: 3, created: "2026-08-31T12:00:00.000Z" }]);
      }
    });
    const client = new JiraCloudRestV3Client(transport);
    await client.uploadAttachment({
      issueId: "10001",
      filename: "a.txt",
      contentType: "text/plain",
      sizeBytes: 3,
      source: { sizeBytes: 3, async *read() { yield Uint8Array.from([1, 2, 3]); } }
    });
    expect(calls).toBe(1);
    expect(sentHeaders["X-Atlassian-Token"]).toBe("no-check");
    expect(sentHeaders["Content-Type"]).toContain("multipart/form-data; boundary=feedback-test-boundary-1234");
    expect(Number(sentHeaders["Content-Length"])).toBe(receivedBytes);
  });

  it("REST write redirectを追跡しない", async () => {
    let calls = 0;
    const transport = createJiraCloudFetchTransport({
      baseUrl: "https://example.atlassian.net",
      authorization: "Bearer test-only",
      timeoutMilliseconds: 1_000,
      fetch: async () => {
        calls += 1;
        return response(307, null, { location: "https://evil.example/write" });
      }
    });
    await expect(transport.request({ method: "POST", path: "/rest/api/3/issue", body: { kind: "json", value: {} } }))
      .rejects.toMatchObject({ code: "feedback.provider_unavailable", retryable: false });
    expect(calls).toBe(1);
  });

  it("attachment GETだけHTTPS cross-origin redirectを許しcredentialを転送しない", async () => {
    const authorizations: Array<string | undefined> = [];
    const transport = createJiraCloudFetchTransport({
      baseUrl: "https://example.atlassian.net",
      authorization: "Bearer test-only",
      timeoutMilliseconds: 1_000,
      fetch: async (_url, init) => {
        authorizations.push(init.headers.Authorization);
        if (authorizations.length === 1) return response(303, null, { location: "https://cdn.example.test/file" });
        return {
          status: 200,
          headers: headers({ "content-type": "application/octet-stream" }),
          async json() { return null; },
          async text() { return ""; },
          body: (async function* () { yield Uint8Array.from([1]); })()
        };
      }
    });
    const result = await transport.request({ method: "GET", path: "/rest/api/3/attachment/content/30001", responseMode: "stream" });
    expect(result.status).toBe(200);
    expect(authorizations).toEqual(["Bearer test-only", undefined]);
  });

  it("JSON responseの宣言sizeと実測sizeを上限で拒否する", async () => {
    const declared = createJiraCloudFetchTransport({
      baseUrl: "https://example.atlassian.net",
      authorization: "Bearer test-only",
      timeoutMilliseconds: 1_000,
      fetch: async () => response(200, {}, { "content-type": "application/json", "content-length": "2097153" })
    });
    await expect(declared.request({ method: "GET", path: "/rest/api/3/issue/1" }))
      .rejects.toMatchObject({ code: "feedback.provider_unavailable" });

    const measured = createJiraCloudFetchTransport({
      baseUrl: "https://example.atlassian.net",
      authorization: "Bearer test-only",
      timeoutMilliseconds: 1_000,
      fetch: async () => response(200, "x".repeat(2 * 1024 * 1024 + 1), { "content-type": "text/plain" })
    });
    await expect(measured.request({ method: "GET", path: "/rest/api/3/issue/1" }))
      .rejects.toMatchObject({ code: "feedback.provider_unavailable" });
  });

  it("cancel済みsignalではfetchもsource readも開始しない", async () => {
    let fetchCalls = 0;
    let reads = 0;
    const transport = createJiraCloudFetchTransport({
      baseUrl: "https://example.atlassian.net",
      authorization: "Bearer test-only",
      timeoutMilliseconds: 1_000,
      fetch: async () => { fetchCalls += 1; return response(200, {}); }
    });
    const signal = { aborted: true, subscribe() { return () => {}; } };
    await expect(transport.request({
      method: "POST",
      path: "/rest/api/3/issue/10001/attachments",
      body: {
        kind: "multipart-file",
        fieldName: "file",
        filename: "a.txt",
        contentType: "text/plain",
        sizeBytes: 1,
        content: (async function* () { reads += 1; yield Uint8Array.from([1]); })()
      },
      signal
    })).rejects.toBeInstanceOf(JiraCloudRequestCancelledError);
    expect(fetchCalls).toBe(0);
    expect(reads).toBe(0);
  });

  it.each([
    [403, "feedback.forbidden", 403, false],
    [404, "feedback.not_found", 404, false],
    [409, "feedback.conflict", 409, false],
    [413, "feedback.payload_too_large", 413, false],
    [415, "feedback.unsupported_media_type", 415, false],
    [429, "feedback.rate_limited", 429, true],
    [503, "feedback.provider_unavailable", 502, true]
  ] as const)("HTTP %sを%sへ正規化する", (providerStatus, code, status, retryable) => {
    const problem = normalizeJiraCloudResponse({
      status: providerStatus,
      headers: providerStatus === 429 ? { "retry-after": "7" } : {},
      body: { errorMessages: ["synthetic"] }
    }, true);
    expect(problem).toMatchObject({ code, status, retryable, resultUnknown: providerStatus === 429 || providerStatus >= 500 });
    expect(problem.message).not.toContain("synthetic");
    if (providerStatus === 429) expect(problem.retryAfterSeconds).toBe(7);
  });

  it("provider timeoutを504かつwrite結果不明へ正規化する", async () => {
    const transport = createJiraCloudFetchTransport({
      baseUrl: "https://example.atlassian.net",
      authorization: "Bearer test-only",
      timeoutMilliseconds: 1,
      fetch: async (_url, init) => new Promise<JiraCloudFetchResponse>((_resolve, reject) => {
        const signal = init.signal as { addEventListener(type: "abort", listener: () => void): void };
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      })
    });
    await expect(transport.request({ method: "POST", path: "/rest/api/3/issue", body: { kind: "json", value: {} } }))
      .rejects.toMatchObject({ code: "feedback.provider_timeout", status: 504, resultUnknown: true });
  });
});
