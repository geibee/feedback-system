import { describe, expect, it } from "vitest";
import type { FeedbackHostContextV1, FeedbackTargetV1 } from "./index.js";

const hostContextWithoutLocale: FeedbackHostContextV1 = {
  schemaVersion: "1",
  applicationKey: "inventory",
  environmentKey: "production",
  externalWorkspaceKey: "inventory-production",
  release: "2026.08.30"
};

function targetKind(target: FeedbackTargetV1): string {
  switch (target.kind) {
    case "ui-element":
    case "screen-position":
    case "map-feature":
    case "map-position":
    case "custom":
      return target.kind;
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

describe("alpha.3〜alpha.6公開型との互換性", () => {
  it("localeなしのhost contextと5種類のtarget unionを維持する", () => {
    expect(hostContextWithoutLocale.locale).toBeUndefined();
    expect(targetKind({
      schemaVersion: "1",
      kind: "custom",
      provider: "io.github.geibee.feedback.dom",
      targetKey: "document",
      fallbackRelativeX: 0.25,
      fallbackRelativeY: 0.75,
      metadata: { coordinateSpace: "document", documentX: 320, documentY: 1200 }
    })).toBe("custom");
  });
});
