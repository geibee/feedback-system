import { describe, expect, it } from "vitest";
import { ExtensionRedmineFeedbackTransport, type RuntimeLike } from "./extension-transport.js";

describe("extension transport response validation", () => {
  it("contractにないerror codeを信頼しない", async () => {
    const runtime = {
      sendMessage: async (message: unknown) => {
        const request = message as { requestId: string; type: string };
        return {
          contractVersion: "1",
          requestId: request.requestId,
          type: request.type,
          ok: false,
          error: { code: "evil.redirect", message: "unknown", retryable: false, upstreamStatus: null }
        };
      },
      connect: () => { throw new Error("unused"); }
    } as RuntimeLike;
    const transport = new ExtensionRedmineFeedbackTransport("inventory-production", runtime);
    await expect(transport.getCapabilities("inventory-production")).rejects.toMatchObject({ code: "redmine.contract_invalid" });
  });
});
