import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createFeedbackBacklogConnector } from "@geibee/feedback-connector-backlog";
import { createFeedbackEnvelopeCodec } from "@geibee/feedback-envelope";
import { describe, expect, it } from "vitest";
import { FakeBacklog } from "./reference-live-fixture.js";
// @ts-expect-error 外部writeのないfixtureでも本番live runnerと同じ実装を実行する。
import { runFeedbackReferenceAcceptance } from "../../../scripts/lib/feedback-reference-acceptance.mjs";
// @ts-expect-error 実際の一回の観測と判断を照合するlive専用JavaScript。
import { assertBestEffortDuplicateRecovery } from "../../../scripts/lib/feedback-duplicate-acceptance.mjs";
// @ts-expect-error live runnerのdigestを共有する。
import { feedbackLiveDigest } from "../../../scripts/lib/feedback-live-digest.mjs";
// @ts-expect-error Jira live cleanup ownershipのJavaScript実装を直接固定する。
import { trackJiraLiveRepository } from "../../../scripts/lib/feedback-jira-live-ownership.mjs";

describe("共通参照live runnerのオフライン回帰", () => {
  it("実Service・client・Backlog Connectorで重複先を分離し全操作を完了する", async () => {
    const transport = new FakeBacklog();
    const scope = { profileId: "live-fixture", installationId: "fixture-site", workspaceId: "FB", resource: { kind: "record", key: "record-1" } };
    const envelopeSecret = new Uint8Array(32).fill(7);
    const codec = createFeedbackEnvelopeCodec([{ kid: "test", secret: envelopeSecret, state: "active" }]);
    const createRepository = (participantId: string) => createFeedbackBacklogConnector({
      configuration: { ...scope, participantId, application: "inventory", environment: "test", workspaceDisplayName: "Feedback",
        projectId: 1, issueTypeId: 2, priorityId: 3, customFieldIds: { threadId: 11, intentId: 12, requestHash: 13, resourceKey: 14 },
        pageSize: 100, recoveryRetryAfterSeconds: 2, maximumMetadataBytes: 32768 },
      transport, envelopeCodec: codec
    });
    const result = await runFeedbackReferenceAcceptance({
      scope, codec, envelopeSecret, envelopeKid: "test", providerCredential: JSON.stringify({ kind: "backlog-api-key", apiKey: "fixture" }),
      title: "live runner fixture", runtimeProfile: { id: "fixture", connectorKey: "backlog", application: "inventory", environment: "test" },
      createRepository,
      async createDuplicate(query: Parameters<ReturnType<typeof createRepository>["createThread"]>[0]) {
        await createRepository(randomUUID()).createThread(query);
      },
      async verifyDuplicate() {
        expect(transport.issues).toHaveLength(2);
        expect(transport.comments.get(1)).toHaveLength(2);
        expect(transport.comments.get(2) ?? []).toHaveLength(0);
      }
    });
    expect(result).toEqual({ publicCredential: true, create: true, read: true, reply: true, revision: true, recovery: true,
      serviceReconstruction: true, noSearchFallback: true, tamperRejected: true, scopeRejected: true,
      currentAuthorization: true, duplicateTargetIsolated: true, attachment: "unsupported" });
  });

  it.each([0, 1, 2])("実観測%d件だけの判断を検証し、全体一意性を保証しない", (count) => {
    const query = { intentId: "intent", requestHash: "hash" };
    const candidates = Array.from({ length: count }, () => ({ projection: query }));
    const state = count === 0 ? "pending" : count === 1 ? "completed" : "repair_required";
    const result = { state, ...(state === "completed" ? {} : { automaticWriteAllowed: false }), retryDirective: "do-not-write" };
    expect(assertBestEffortDuplicateRecovery(candidates, query, result)).toEqual({
      observedCandidateCount: count, recoveryState: state, globalUniquenessProven: false
    });
    expect(() => assertBestEffortDuplicateRecovery(candidates, query, { ...result, automaticWriteAllowed: true })).toThrow();
  });
  it("複数候補をcompletedとした証跡を拒否する", () => {
    expect(() => assertBestEffortDuplicateRecovery([{}, {}], {}, { state: "completed", automaticWriteAllowed: false })).toThrow();
  });
  it("provider別に再現可能な実装digestを作る", () => {
    const root = resolve(process.cwd(), "../..");
    expect(feedbackLiveDigest("backlog", root)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(feedbackLiveDigest("backlog", root)).toBe(feedbackLiveDigest("backlog", root));
    expect(feedbackLiveDigest("backlog", root)).not.toBe(feedbackLiveDigest("jira-cloud", root));
  });

  it("Jira Service内createの解決IDを既存callbackとcleanup集合の両方へ渡す", async () => {
    const issueIds = new Set<string>();
    const callbacks: string[] = [];
    const repository = trackJiraLiveRepository({
      async createThread(_query: unknown, options: { onThreadResolved?: (reference: { providerKey: string; objectId: string }) => void }) {
        options.onThreadResolved?.({ providerKey: "jira-cloud", objectId: "10002" });
        return { disposition: "created" };
      }
    }, issueIds);
    await repository.createThread({}, { onThreadResolved: (reference: { objectId: string }) => callbacks.push(reference.objectId) });
    expect([...issueIds]).toEqual(["10002"]);
    expect(callbacks).toEqual(["10002"]);
  });
});
