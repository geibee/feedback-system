import { describe, expect, it } from "vitest";
import { readCreateMultipart } from "./multipart.js";

describe("create multipart", () => {
  it("request JSONとevidenceの2 partをbrowser FormDataから読み取る", async () => {
    const evidence = Uint8Array.from([1, 2, 3, 4]);
    const form = new FormData();
    form.append("request", new Blob([JSON.stringify({ schemaVersion: "1" })], { type: "application/json" }));
    form.append("evidence", new Blob([evidence], { type: "image/png" }), "feedback.png");

    const request = new Request("https://app.example/internal/feedback-redmine/v1", {
      method: "POST",
      body: form
    });
    const parsed = await readCreateMultipart(request, 1024);

    expect(parsed.request).toEqual({ schemaVersion: "1" });
    expect(parsed.evidence).toEqual({
      bytes: evidence,
      filename: "feedback.png",
      contentType: "image/png"
    });
  });
});
