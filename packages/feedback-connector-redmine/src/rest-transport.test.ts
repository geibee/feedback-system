import { describe, expect, it, vi } from "vitest";
import { createFeedbackRedmineRestTransport, type RedmineFetch, type RedmineFetchResponse } from "./rest-transport.js";

describe("Redmine REST production transport", () => {
  it("scope custom fieldをprovider searchへ完全一致filterとして渡す", async () => {
    const fetch = vi.fn<RedmineFetch>(async () => response(200, {
      issues: [], total_count: 0, offset: 0, limit: 100
    }));
    const transport = createFeedbackRedmineRestTransport({
      baseUrl: "https://redmine.example/redmine",
      apiKey: "server-secret",
      fetch
    });
    await transport.searchIssues({
      projectId: 10,
      customFieldFilters: { 1: "thread", 8: "workspace" },
      offset: 0,
      limit: 100,
      order: "updated_desc"
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toContain("project_id=10");
    expect(url).toContain("cf_1=thread");
    expect(url).toContain("cf_8=workspace");
    expect(init.headers).toMatchObject({ "X-Redmine-API-Key": "server-secret" });
  });

  it("upload streamのsize/hashを送信前に検証しbinary POSTを一回だけ行う", async () => {
    const fetch = vi.fn<RedmineFetch>(async () => response(201, { upload: { token: "token-1" } }));
    const transport = createFeedbackRedmineRestTransport({
      baseUrl: "https://redmine.example/redmine/",
      apiKey: "server-secret",
      fetch
    });
    const bytes = new TextEncoder().encode("attachment");
    const source = { sizeBytes: bytes.byteLength, async *read() { yield bytes; } };
    await expect(transport.upload(source, {
      filename: "evidence.txt",
      contentType: "text/plain",
      contentHash: "sha256:602a5e69c3021bdbd3d25156a02d2cbb467605b8203248eea6af3fb42168d663"
    })).resolves.toEqual({ token: "token-1" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "POST", body: bytes });

    await expect(transport.upload(source, {
      filename: "evidence.txt",
      contentType: "text/plain",
      contentHash: `sha256:${"0".repeat(64)}`
    })).rejects.toMatchObject({ code: "feedback.integrity_error" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("attachment content URLがprofile origin外ならcontentを取得しない", async () => {
    const fetch = vi.fn<RedmineFetch>(async () => response(200, {
      attachment: {
        id: 5,
        filename: "secret.txt",
        filesize: 1,
        content_type: "text/plain",
        content_url: "https://attacker.example/secret"
      }
    }));
    const transport = createFeedbackRedmineRestTransport({
      baseUrl: "https://redmine.example/redmine/",
      apiKey: "server-secret",
      fetch
    });
    await expect(transport.downloadAttachment("5")).rejects.toMatchObject({ code: "feedback.integrity_error" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

function response(status: number, value: unknown): RedmineFetchResponse {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? "application/json" : null },
    async json() { return value; },
    async text() { return JSON.stringify(value); },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
  };
}
