import { describe, expect, it } from "vitest";
import { feedbackReactContractVersion, installFeedbackReactStyles } from "./index.js";

describe("React renderer contract", () => {
  it("frozen controller契約version 2へ接続する", () => {
    expect(feedbackReactContractVersion).toBe("2");
  });

  it("DocumentとShadow RootへCSP nonce付きstyleを明示導入して解除できる", () => {
    const removeDocumentStyle = installFeedbackReactStyles(document, "document-nonce");
    expect(document.head.querySelector("style")?.nonce).toBe("document-nonce");
    removeDocumentStyle();
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const removeShadowStyle = installFeedbackReactStyles(shadow, "shadow-nonce");
    expect(shadow.querySelector("style")?.nonce).toBe("shadow-nonce");
    removeShadowStyle();
    expect(shadow.childNodes).toHaveLength(0);
  });
});
