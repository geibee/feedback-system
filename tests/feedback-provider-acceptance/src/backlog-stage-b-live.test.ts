// @ts-expect-error live runnerと同じJavaScript digest実装を使用する。
import { feedbackLiveDigest } from "../../../scripts/lib/feedback-live-digest.mjs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import liveConformance from "../../fixtures/backlog-stage-b/live-conformance.json";

describe("Backlog Connector Stage B live Conformance", () => {
  it("実Connectorの回復、再構築、unsupported、cleanupを現sourceへ束縛する", () => {
    expect(liveConformance).toMatchObject({
      schemaVersion: "1",
      kind: "backlog-stage-b-live-conformance",
      contractVersion: "2.0.0-alpha.3",
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
        observedDuplicateDecisionVerified: true,
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
      threadReference: { publicCredential: true, create: true, read: true, reply: true, revision: true, recovery: true,
        serviceReconstruction: true, noSearchFallback: true, tamperRejected: true, scopeRejected: true,
        currentAuthorization: true, duplicateTargetIsolated: true, attachment: "unsupported" },
      duplicateObservation: { globalUniquenessProven: false },
      cleanup: "deleted-all-run-owned-issues"
    });
    expect(liveConformance.implementationDigest).toBe(implementationDigest());
  });
});

function implementationDigest(): string {
  return feedbackLiveDigest("backlog", resolve(process.cwd(), "../.."));
}
