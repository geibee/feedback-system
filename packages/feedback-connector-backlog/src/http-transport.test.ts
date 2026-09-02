import { describe, expect, it } from "vitest";
import { createBacklogFetchTransport } from "./http-transport.js";
import type { BacklogFetch } from "./types.js";

describe("Backlog HTTP transport", () => {
  it("API keyをqueryへ出さずheaderへだけ設定し、formをencodeする", async () => {
    let seenUrl = "";
    let seenInit: Parameters<BacklogFetch>[1] | undefined;
    const fetch: BacklogFetch = async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return { status: 200, headers: new Headers({ "content-type": "application/json" }), async text() { return "{}"; } };
    };
    const transport = createBacklogFetchTransport({ baseUrl: "https://example.backlog.com", apiKey: "secret", fetch, timeoutMilliseconds: 1000 });
    await transport.request({ method: "POST", path: "/api/v2/issues", body: { kind: "form", values: { summary: "日本語", "customField_1": "value" } } });
    expect(seenUrl).toBe("https://example.backlog.com/api/v2/issues");
    expect(seenInit?.headers).toMatchObject({ "Backlog-API-Key": "secret" });
    expect(seenInit?.body).toContain("summary=%E6%97%A5%E6%9C%AC%E8%AA%9E");
    expect(seenUrl).not.toContain("secret");
  });
});
