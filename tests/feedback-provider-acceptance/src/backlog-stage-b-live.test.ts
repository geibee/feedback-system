import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import liveConformance from "../../fixtures/backlog-stage-b/live-conformance.json";

describe("Backlog Connector Stage B live Conformance", () => {
  it("実Connectorの回復、再構築、unsupported、cleanupを現sourceへ束縛する", () => {
    expect(liveConformance).toMatchObject({
      schemaVersion: "1",
      kind: "backlog-stage-b-live-conformance",
      contractVersion: "2.0.0-alpha.2",
      tenantIdentifiersRemoved: true,
      provisioning: {
        fourTextCustomFieldsReady: true,
        projectIssueTypePriorityReady: true
      },
      capabilities: {
        createReplyRevisionRecoverable: true,
        attachmentReadUploadUnsupported: true,
        resourceDiscoveryUnsupported: true
      },
      recovery: {
        zeroCreateHitPending: true,
        createResponseLostAfterCommit: true,
        createRecoveredFromProvider: true,
        replyResponseLostAfterCommit: true,
        replyRecoveredFromProvider: true,
        revisionResponseLostAfterCommit: true,
        revisionRecoveredFromProvider: true,
        duplicateThreadRepairRequired: true,
        automaticWriteRetry: false
      },
      roundtrip: {
        workspace: true,
        resourceProjection: true,
        body: true,
        reply: true,
        appendOnlyRevision: true,
        signedMetadata: true
      },
      restartReconstruction: {
        separateProcess: true,
        providerObjectIdentifiersPassed: false,
        threadRecovered: true,
        intentsRecovered: true,
        resourceProjectionRecovered: true
      },
      cleanup: "deleted-all-run-owned-issues"
    });
    expect(liveConformance.implementationDigest).toBe(implementationDigest());
  });
});

function implementationDigest(): string {
  const files = [
    "packages/feedback-connector-backlog/src/connector.ts",
    "packages/feedback-connector-backlog/src/http-transport.ts",
    "packages/feedback-connector-backlog/src/provisioning.ts",
    "packages/feedback-connector-backlog/src/rest-v2-client.ts",
    "packages/feedback-connector-backlog/src/types.ts",
    "scripts/run-feedback-backlog-live-conformance.mjs"
  ];
  const digest = createHash("sha256");
  for (const file of files) digest.update(file).update("\0").update(readFileSync(resolve(process.cwd(), "../..", file))).update("\0");
  return `sha256:${digest.digest("hex")}`;
}
