import { readFileSync } from "node:fs";
import type { FeedbackProviderProfileV2 } from "@geibee/feedback-contracts/v2/server";
import { describe, expect, it, vi } from "vitest";
import {
  createFakeFeedbackAuthorizationPort,
  feedbackAuthorizationModes,
  intersectFeedbackOperations,
  selectFeedbackAuthorizationPort
} from "./index.js";

const profile = JSON.parse(readFileSync(
  new URL("../../../contracts/feedback/fixtures/v2/provider-profile-signed-grant.json", import.meta.url),
  "utf8"
)) as FeedbackProviderProfileV2;

describe("Authorization Mode契約", () => {
  it("profileへ固定できる3 modeだけを公開する", () => {
    expect(feedbackAuthorizationModes).toEqual([
      "public-profile",
      "signed-grant",
      "remote-authorization"
    ]);
  });

  it("profileに固定されたmode以外へfallbackしない", () => {
    const publicPort = createFakeFeedbackAuthorizationPort("public-profile", vi.fn());
    expect(() => selectFeedbackAuthorizationPort(profile, new Map([["public-profile", publicPort]])))
      .toThrow(/固定Authorization Mode/);

    const mislabeled = { ...publicPort, mode: "remote-authorization" as const };
    expect(() => selectFeedbackAuthorizationPort(profile, new Map([["signed-grant", mislabeled]])))
      .toThrow(/固定Authorization Mode/);
  });

  it("認可、profile policy、backend capabilityの積集合だけを許可する", () => {
    expect(intersectFeedbackOperations(
      ["feedback:read", "feedback:create", "feedback:attachment:upload"],
      ["feedback:read", "feedback:create"],
      ["feedback:read", "feedback:attachment:upload"]
    )).toEqual(["feedback:read"]);
  });

  it("profile/workspace/resourceの対象levelを保ってdecisionを記録する", async () => {
    const port = createFakeFeedbackAuthorizationPort("remote-authorization", async (request) => ({
      target: request.target,
      mode: "remote-authorization",
      subjectId: "subject-opaque",
      allowedOperations: ["feedback:read"]
    }));
    const target = {
      level: "resource",
      profileId: "inventory-production",
      workspaceId: "OPS",
      resource: { kind: "record", key: "order-001" }
    } as const;
    const decision = await port.authorize({
      target,
      requestedOperations: ["feedback:read"],
      grant: {
        mode: "remote-authorization",
        source: "authenticated-adapter",
        subjectId: "subject-opaque",
        remoteRequest: {
          schemaVersion: "1",
          target,
          requestedOperations: ["feedback:read"],
          subject: { id: "subject-opaque", source: "authenticated-adapter" }
        }
      }
    });
    expect(decision.target).toEqual(target);
    expect(port.calls).toHaveLength(1);
  });
});
