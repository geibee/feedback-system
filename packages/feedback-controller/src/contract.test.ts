import { describe, expect, it } from "vitest";
import { controllerSnapshotGolden } from "./fixtures/controller-snapshot.golden.js";

describe("Feedback controller golden snapshot", () => {
  it("discovery、local state、intent回復、capture cancellation、navigationを固定する", () => {
    expect(controllerSnapshotGolden.discovery.state).toBe("ready");
    expect(controllerSnapshotGolden.localState.followedThreadIds).toHaveLength(1);
    expect(controllerSnapshotGolden.pendingIntents[0]).toMatchObject({
      operation: "feedback:attachment:upload",
      retryPolicy: "manual-confirmation",
      recovery: {
        state: "repair_required",
        automaticWriteAllowed: false,
        retryDirective: "manual-confirmation"
      }
    });
    expect(controllerSnapshotGolden.pendingIntents[0]?.scope.resource).toEqual({ kind: "record", key: "order-001" });
    expect(controllerSnapshotGolden.pendingIntents[0]?.threadId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(controllerSnapshotGolden.capture).toBe("cancelled");
    expect(controllerSnapshotGolden.navigation?.path.startsWith("/")).toBe(true);
  });
});
