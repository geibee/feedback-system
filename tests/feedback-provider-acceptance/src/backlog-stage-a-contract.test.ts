import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertFeedbackConnectorContractFixture } from "@geibee/feedback-connector-sdk/testing";
import { describe, expect, it } from "vitest";
import liveGate from "../../fixtures/backlog-stage-a/live-gate.json";
import providerFacts from "../../fixtures/backlog-stage-a/provider-facts.json";
import { backlogStageAContractFixture } from "./backlog-stage-a-contract-fixture.js";

describe("Backlog Connector Stage A", () => {
  it("既存Connector TCKへ契約変更なしでlive確定fixtureを適用する", () => {
    expect(() => assertFeedbackConnectorContractFixture(backlogStageAContractFixture)).not.toThrow();
    expect(backlogStageAContractFixture.firstThreadWriteFields).toEqual(["threadId", "intentId", "requestHash"]);
    expect(backlogStageAContractFixture.operations.attachmentUpload.automaticBinaryRetry).toBe(false);
    expect(backlogStageAContractFixture.operations.attachmentUpload.signedProviderMapping).toBe(false);
    expect(backlogStageAContractFixture.operations.attachmentUpload.guarantee).toBe("unsupported");
  });

  it("静的事実と匿名化live証跡を分離し、現sourceへHard Gateを束縛する", () => {
    expect(providerFacts.observation.liveSpaceObserved).toBe(false);
    expect(providerFacts.observation.credentialAvailable).toBe(false);
    expect(providerFacts.hardGate).toMatchObject({ status: "pending", passed: false });
    expect(liveGate).toMatchObject({
      tenantIdentifiersRemoved: true,
      hardGate: {
        status: "passed",
        passed: true,
        recoverableOperations: ["create", "reply", "revision"],
        unsupportedOperations: ["attachment-read", "attachment-upload"]
      },
      cleanup: "deleted-all-run-owned-issues"
    });
    expect(liveGate.implementationDigest).toBe(implementationDigest());
    expect(backlogStageAContractFixture.capabilities.backendOperations)
      .not.toContain("feedback:attachment:upload");
  });

  it("正本をBacklog内へ限定し、補完storageを要求しない", () => {
    expect(Object.values(providerFacts.canonicalDataLocations))
      .toHaveLength(7);
    expect(Object.values(providerFacts.forbiddenSupplementalState))
      .toEqual([false, false, false, false, false, false]);
    expect(providerFacts.threadLookup).toMatchObject({
      zeroHitDecision: "pending",
      multipleHitDecision: "repair_required",
      providerUniquenessConstraint: false
    });
    expect(providerFacts.firstThreadWrite.recoveryFields.map((field) => field.logicalName))
      .toEqual(backlogStageAContractFixture.firstThreadWriteFields);
    for (const operation of ["create", "reply", "revision", "attachmentUpload"] as const) {
      if (operation === "attachmentUpload") {
        expect(providerFacts.operations[operation].staticGuarantee).toBe("best-effort");
      } else {
        expect(backlogStageAContractFixture.operations[operation].guarantee).toBe("recoverable");
      }
    }
  });
});

function implementationDigest(): string {
  const files = [
    "contracts/feedback/schemas/feedback-envelope.schema.json",
    "contracts/feedback/schemas/feedback-message-marker.schema.json",
    "contracts/feedback/schemas/feedback-attachment-marker.schema.json",
    "packages/feedback-envelope/src/index.ts",
    "scripts/run-feedback-backlog-stage-a.mjs"
  ];
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(readFileSync(resolve(process.cwd(), "../..", file))).update("\0");
  return `sha256:${hash.digest("hex")}`;
}
