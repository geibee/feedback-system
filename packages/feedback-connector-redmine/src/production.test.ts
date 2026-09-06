import { describe, expect, it } from "vitest";
import { FeedbackConnectorProblem, type FeedbackAbortSignal, type FeedbackRepositoryScope } from "@geibee/feedback-connector-sdk";
import { calculateFeedbackCommandHash, createFeedbackEnvelopeCodec } from "@geibee/feedback-envelope";
import { createFeedbackRedmineConnector } from "./connector.js";
import { mapRedmineIssue, redmineProjectionCandidate } from "./mapper.js";
import { buildDualWriteRedmineNote, parseRedmineMessageNote } from "./markers.js";
import { feedbackRedmineV2ProvisioningFields, inspectRedmineV2Provisioning, planRedmineV2Provisioning } from "./provisioning.js";
import type {
  FeedbackRedmineProfileV2,
  FeedbackRedmineTransportPort,
  RedmineIssueInput,
  RedmineIssueRaw,
  RedmineIssueUpdate
} from "./redmine-types.js";

const ids = {
  threadId: 1,
  intentId: 2,
  requestHash: 3,
  envelope: 4,
  projection: 5,
  applicationKey: 6,
  environmentKey: 7,
  externalWorkspaceKey: 8,
  hostResourceKey: 9
} as const;

const profile: FeedbackRedmineProfileV2 = {
  profileId: "feedback-redmine",
  installationId: "redmine-installation",
  displayName: "Feedback Redmine",
  applicationKey: "orders",
  environmentKey: "test",
  workspaceId: "support",
  workspaceDisplayName: "Support",
  projectId: 10,
  trackerId: 20,
  isPrivate: true,
  defaultPriorityId: 30,
  participantId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5007",
  participantDisplayName: "利用者A",
  customFieldIds: ids,
  maximumAttachmentBytes: 5_242_880,
  attachmentContentTypes: ["text/plain", "application/octet-stream"]
};

const scope: FeedbackRepositoryScope = {
  profileId: profile.profileId,
  installationId: profile.installationId,
  workspaceId: profile.workspaceId,
  resource: { kind: "record", key: "order-42" }
};

const codec = createFeedbackEnvelopeCodec([{
  kid: "redmine-test",
  secret: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
  state: "active"
}]);

const threadId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5001";
const createIntentId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5002";
const replyIntentId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5003";
const messageId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5004";
const revisionIntentId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5005";
const revisionId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5006";

describe("Redmine production Connector", () => {
  it("未検証v1編集でv2の本文と所有者を上書きしない", async () => {
    const provider = new MemoryRedmine();
    const connector = repository(provider);
    await connector.createThread({ ...scope, command: createCommand() });
    await connector.reply({ ...scope, threadId, command: {
      intentId: replyIntentId, requestHash: requestHash(replyIntentId), messageId, body: "署名済み返信"
    } });
    await provider.updateIssue(provider.onlyIssue().id, { notes: buildDualWriteRedmineNote("偽造本文", {
      kind: "edit", messageId, participantId: profile.participantId, participantName: "偽装", version: 2,
      intentId: revisionIntentId, signature: "INVALID"
    }) });
    const mapped = await mapRedmineIssue(provider.onlyIssue(), profile, scope, codec);
    expect(mapped.thread.messages.find((message) => message.messageId === messageId)).toMatchObject({
      body: "署名済み返信", author: { kind: "participant", participantId: profile.participantId }
    });
    expect(mapped.warnings).not.toHaveLength(0);
  });

  it("v1互換の空白正規化と署名本文hashをreply／revisionで一致させる", async () => {
    const provider = new MemoryRedmine();
    const connector = repository(provider);
    await connector.createThread({ ...scope, command: createCommand() });
    await expect(connector.reply({ ...scope, threadId, command: {
      intentId: replyIntentId, requestHash: requestHash(replyIntentId), messageId, body: "  返信\r\n\r\n本文\r\n"
    } })).resolves.toMatchObject({ message: { body: "返信\n\n本文" } });
    await expect(connector.appendRevision({ ...scope, threadId, messageId, command: {
      intentId: revisionIntentId, requestHash: requestHash(revisionIntentId), revisionId,
      expectedRevisionId: messageId, body: " 改訂\r\n"
    } })).resolves.toMatchObject({ message: { body: "改訂" } });
  });

  it("初期本文の改変を拒否し、hashのない旧Envelopeを本人本文へ昇格しない", async () => {
    const provider = new MemoryRedmine();
    await repository(provider).createThread({ ...scope, command: createCommand() });
    const issue = provider.onlyIssue();
    issue.description = "改変本文";
    await expect(mapRedmineIssue(issue, profile, scope, codec)).rejects.toMatchObject({ code: "feedback.integrity_error" });
    const field = (issue.custom_fields as Array<{ id: number; value: string }>).find((field) => field.id === ids.envelope)!;
    const { signature: _signature, initialBodyHash: _hash, ...payload } = JSON.parse(field.value);
    field.value = JSON.stringify(await codec.signEnvelope(payload));
    const old = await mapRedmineIssue(issue, profile, scope, codec);
    expect(old.thread.messages[0]).toMatchObject({ body: "改変本文", author: { kind: "provider-user" } });
  });
  it("provider provisioningを明示し、不足とfield ID重複をfail-closedにする", () => {
    expect(feedbackRedmineV2ProvisioningFields.map((field) => field.key)).toEqual(Object.keys(ids));
    expect(inspectRedmineV2Provisioning(ids)).toEqual({ ready: true, missing: [], duplicateIds: [] });
    expect(inspectRedmineV2Provisioning({ ...ids, projection: 0 })).toMatchObject({ ready: false, missing: ["projection"] });
    expect(inspectRedmineV2Provisioning({ ...ids, projection: ids.envelope })).toMatchObject({ ready: false, duplicateIds: [ids.envelope] });
    const ready = planRedmineV2Provisioning(feedbackRedmineV2ProvisioningFields.map((field, index) => ({
      id: index + 1,
      name: field.name,
      format: field.format,
      searchable: field.searchable
    })));
    expect(ready.ready).toBe(true);
    const conflict = planRedmineV2Provisioning([{ id: 1, name: "Feedback Thread ID", format: "text", searchable: false }]);
    expect(conflict.ready).toBe(false);
    expect(conflict.operations[0]).toMatchObject({ key: "threadId", action: "conflict" });
  });

  it("最初のwriteへtripletを同時保存し、Envelopeとprojectionをproviderへ段階保存する", async () => {
    const provider = new MemoryRedmine();
    const connector = repository(provider);
    const operationSignal = testSignal();
    const result = await connector.createThread({ ...scope, command: createCommand() }, { signal: operationSignal });
    expect("disposition" in result && result.disposition).toBe("created");
    expect(provider.firstWrites).toHaveLength(1);
    const first = fieldMap(provider.firstWrites[0]!.custom_fields);
    expect(first.get(ids.threadId)).toBe(threadId);
    expect(first.get(ids.intentId)).toBe(createIntentId);
    expect(first.get(ids.requestHash)).toBe(requestHash(createIntentId).slice("sha256:".length));
    expect(first.has(ids.envelope)).toBe(false);
    expect(first.has(ids.projection)).toBe(false);
    expect(provider.updatePhases).toEqual(["envelope", "projection"]);
    expect(provider.provisionSignals).not.toHaveLength(0);
    expect(provider.provisionSignals.every((signal) => signal === operationSignal)).toBe(true);

    const restarted = repository(provider);
    await expect(restarted.recoverIntent({
      ...scope,
      threadId,
      intentId: createIntentId,
      requestHash: requestHash(createIntentId),
      operation: "feedback:create"
    })).resolves.toEqual({
      intentId: createIntentId,
      state: "completed",
      operation: "feedback:create",
      stableResultId: threadId
    });
    expect(provider.createCalls).toBe(1);
  });

  it("create response喪失後は再POSTせずseedを回収してEnvelope/projectionを補修する", async () => {
    const provider = new MemoryRedmine();
    provider.createFailure = "after-apply";
    const result = await repository(provider).createThread({ ...scope, command: createCommand() });
    expect("disposition" in result && result.disposition).toBe("recovered");
    expect(provider.createCalls).toBe(1);
    expect(provider.issues.size).toBe(1);
    expect(provider.updatePhases).toEqual(["envelope", "projection"]);
  });

  it("再送されたcreateがseed-only issueを見つけた場合も新規POSTせず不足artifactだけを補修する", async () => {
    const provider = new MemoryRedmine();
    provider.seedIssue(createCommand());
    const operationSignal = testSignal();
    const result = await repository(provider).createThread({ ...scope, command: createCommand() }, { signal: operationSignal });
    expect(result).toMatchObject({ state: "completed", stableResultId: threadId });
    expect(provider.createCalls).toBe(0);
    expect(provider.issues.size).toBe(1);
    expect(provider.updatePhases).toEqual(["envelope", "projection"]);
    expect(provider.provisionSignals).not.toHaveLength(0);
    expect(provider.provisionSignals.every((signal) => signal === operationSignal)).toBe(true);
  });

  it.each([
    ["malformed JSON", "{"],
    ["invalid shape", JSON.stringify({ schemaVersion: "2", threadId })]
  ])("projection custom fieldが%sならlegacy projectionへfallbackしない", async (_label, value) => {
    const provider = new MemoryRedmine();
    const issue = provider.seedLegacyIssue({});
    (issue.custom_fields as Array<{ id: number; value: unknown }>).push({ id: ids.projection, value });
    expect(() => redmineProjectionCandidate(issue, profile, scope.resource)).toThrowError(/projection custom field/u);
    await expect(repository(provider).findThreadCandidates({ ...scope })).rejects.toMatchObject({ code: "feedback.integrity_error" });
  });

  it("Envelope後projection前の失敗を同じissueへ補修し、新規ticketを作らない", async () => {
    const provider = new MemoryRedmine();
    provider.failPhaseBefore = "projection";
    const result = await repository(provider).createThread({ ...scope, command: createCommand() });
    expect("disposition" in result && result.disposition).toBe("recovered");
    expect(provider.createCalls).toBe(1);
    expect(provider.issues.size).toBe(1);
    expect(provider.updatePhases).toEqual(["envelope", "projection"]);
  });

  it("timeout後の検索0件はpending、複数件はrepair_requiredとし自動再createしない", async () => {
    const missing = new MemoryRedmine();
    missing.createFailure = "before-apply";
    const pending = await repository(missing).createThread({ ...scope, command: createCommand() });
    expect(pending).toMatchObject({ state: "pending", automaticWriteAllowed: false });
    expect(missing.createCalls).toBe(1);

    const duplicate = new MemoryRedmine();
    duplicate.seedIssue(createCommand());
    duplicate.seedIssue(createCommand());
    const repaired = await repository(duplicate).createThread({ ...scope, command: createCommand() });
    expect(repaired).toMatchObject({ state: "repair_required", automaticWriteAllowed: false });
    expect(duplicate.createCalls).toBe(0);
  });

  it("reply/revisionをv1 markerと署名v2 markerの一writeへdual-writeし、process再起動後も回収する", async () => {
    const provider = new MemoryRedmine();
    const connector = repository(provider);
    await connector.createThread({ ...scope, command: createCommand() });
    provider.failNextNoteAfterApply = true;
    const reply = await connector.reply({
      ...scope,
      threadId,
      command: { intentId: replyIntentId, requestHash: requestHash(replyIntentId), messageId, body: "返信 v2" }
    });
    expect("disposition" in reply && reply.disposition).toBe("recovered");
    expect(provider.noteWrites).toBe(1);
    const issue = provider.onlyIssue();
    const replyNote = parseRedmineMessageNote((issue.journals as Array<{ notes: string }>)[0]!.notes)!;
    expect(replyNote.body).toBe("返信 v2");
    expect(replyNote.metadata.kind).toBe("reply");
    expect(replyNote.metadata.feedbackV2?.eventKind).toBe("reply");

    const revision = await repository(provider).appendRevision({
      ...scope,
      threadId,
      messageId,
      command: {
        intentId: revisionIntentId,
        requestHash: requestHash(revisionIntentId),
        revisionId,
        expectedRevisionId: messageId,
        body: "返信 v2 編集"
      }
    });
    expect("message" in revision && revision.message.body).toBe("返信 v2 編集");
    expect("message" in revision && revision.message.revisions.map((item) => item.revisionId)).toEqual([messageId, revisionId]);
    expect(provider.noteWrites).toBe(2);
  });

  it("attachment結果不明時はbinaryを一回しか送らずmanual confirmationへ閉じる", async () => {
    const provider = new MemoryRedmine();
    const connector = repository(provider);
    await connector.createThread({ ...scope, command: createCommand() });
    provider.uploadFailure = true;
    const bytes = new TextEncoder().encode("attachment");
    const intentId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5011";
    const attachmentId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5012";
    const result = await connector.uploadAttachment({
      ...scope,
      threadId,
      command: {
        intentId,
        requestHash: requestHash(intentId),
        attachmentId,
        filename: "evidence.txt",
        contentType: "text/plain",
        sizeBytes: bytes.byteLength,
        contentHash: rawHash(bytes),
        purpose: "evidence"
      },
      source: { sizeBytes: bytes.byteLength, async *read() { yield bytes; } }
    });
    expect(result).toMatchObject({ state: "repair_required", retryDirective: "manual-confirmation", automaticWriteAllowed: false });
    const recovery = await connector.recoverIntent({
      ...scope,
      threadId,
      intentId,
      requestHash: requestHash(intentId),
      operation: "feedback:attachment:upload"
    });
    expect(recovery).toMatchObject({ state: "repair_required", retryDirective: "manual-confirmation" });
    expect(provider.uploadCalls).toBe(1);
  });

  it("v1-only ticketをstable IDで再構築し、legacy-only reply/editを保持する", async () => {
    const provider = new MemoryRedmine();
    const legacyMessageId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5021";
    const issue = provider.seedLegacyIssue({
      journals: [
        { id: 1, notes: "Redmine reply", created_on: "2026-08-31T10:01:00Z", user: { name: "Agent" } },
        {
          id: 2,
          notes: buildDualWriteRedmineNote("legacy reply", {
            kind: "reply", messageId: legacyMessageId, participantId: profile.participantId,
            participantName: "利用者A", version: 1, intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5022", signature: "legacy"
          }),
          created_on: "2026-08-31T10:02:00Z",
          user: { name: "Integration" }
        },
        {
          id: 3,
          notes: buildDualWriteRedmineNote("legacy edit", {
            kind: "edit", messageId: legacyMessageId, participantId: profile.participantId,
            participantName: "利用者A", version: 2, intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5023", signature: "legacy"
          }),
          created_on: "2026-08-31T10:03:00Z",
          user: { name: "Integration" }
        }
      ]
    });
    const first = await mapRedmineIssue(issue, profile, scope, codec);
    const second = await mapRedmineIssue(clone(issue), profile, scope, codec);
    expect(first.thread.messages.map((message) => message.messageId)).toEqual(second.thread.messages.map((message) => message.messageId));
    expect(first.thread.messages.find((message) => message.messageId === legacyMessageId)).toMatchObject({
      body: "legacy edit",
      revisions: [{ body: "legacy reply" }, { body: "legacy edit" }]
    });
    expect(first.envelope).toBeNull();
  });

  it("dual-write ticketへv1 gatewayが追加したlegacy-only eventをv2 eventを消さずmergeする", async () => {
    const provider = new MemoryRedmine();
    const connector = repository(provider);
    await connector.createThread({ ...scope, command: createCommand() });
    await connector.reply({
      ...scope,
      threadId,
      command: { intentId: replyIntentId, requestHash: requestHash(replyIntentId), messageId, body: "v2 reply" }
    });
    const legacyMessageId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5031";
    await provider.updateIssue(provider.onlyIssue().id, {
      notes: buildDualWriteRedmineNote("v1 later reply", {
        kind: "reply",
        messageId: legacyMessageId,
        participantId: profile.participantId,
        participantName: profile.participantDisplayName,
        version: 1,
        intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5032",
        signature: "v1-signature"
      })
    });
    await provider.updateIssue(provider.onlyIssue().id, {
      notes: buildDualWriteRedmineNote("v1 later revision", {
        kind: "edit",
        messageId: legacyMessageId,
        participantId: profile.participantId,
        participantName: profile.participantDisplayName,
        version: 2,
        intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5033",
        signature: "v1-signature-2"
      })
    });
    const mapped = await mapRedmineIssue(provider.onlyIssue(), profile, scope, codec);
    expect(mapped.thread.messages.map((item) => item.messageId)).toEqual(expect.arrayContaining([threadId, messageId, legacyMessageId]));
    expect(mapped.thread.messages.find((item) => item.messageId === messageId)?.body).toBe("v2 reply");
    expect(mapped.thread.messages.find((item) => item.messageId === legacyMessageId)).toMatchObject({
      body: "v1 later revision",
      revisions: [{ body: "v1 later reply" }, { body: "v1 later revision" }]
    });
  });

  it("known upload responseだけをassociateし、署名済みstable mappingからdownloadする", async () => {
    const provider = new MemoryRedmine();
    const connector = repository(provider);
    await connector.createThread({ ...scope, command: createCommand() });
    await connector.reply({
      ...scope,
      threadId,
      command: { intentId: replyIntentId, requestHash: requestHash(replyIntentId), messageId, body: "attachment対象の返信" }
    });
    const bytes = new TextEncoder().encode("attachment");
    const intentId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5041";
    const attachmentId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5042";
    const result = await connector.uploadAttachment({
      ...scope,
      threadId,
      command: {
        intentId,
        requestHash: requestHash(intentId),
        attachmentId,
        messageId,
        filename: "evidence.txt",
        contentType: "text/plain",
        sizeBytes: bytes.byteLength,
        contentHash: rawHash(bytes),
        purpose: "evidence"
      },
      source: { sizeBytes: bytes.byteLength, async *read() { yield bytes; } }
    });
    expect(result).toMatchObject({ disposition: "created", attachment: { attachmentId } });
    expect(provider.uploadCalls).toBe(1);
    const mapped = await mapRedmineIssue(provider.onlyIssue(), profile, scope, codec);
    expect(mapped.thread.messages.find((item) => item.messageId === threadId)?.attachments).toEqual([]);
    expect(mapped.thread.messages.find((item) => item.messageId === messageId)?.attachments)
      .toEqual([expect.objectContaining({ attachmentId })]);
    const recovered = await repository(provider).recoverIntent({
      ...scope,
      threadId,
      intentId,
      requestHash: requestHash(intentId),
      operation: "feedback:attachment:upload"
    });
    expect(recovered).toMatchObject({ state: "completed", stableResultId: attachmentId });
    const stream = await connector.getAttachment({ ...scope, threadId, attachmentId });
    expect(stream.filename).toBe("evidence.txt");
    provider.tamperDownload = true;
    await expect(connector.getAttachment({ ...scope, threadId, attachmentId }))
      .rejects.toMatchObject({ code: "feedback.integrity_error" });
  });

  it("存在しないmessageへのattachmentはbinaryを読まずuploadしない", async () => {
    const provider = new MemoryRedmine();
    const connector = repository(provider);
    await connector.createThread({ ...scope, command: createCommand() });
    const bytes = new TextEncoder().encode("attachment");
    let sourceReads = 0;
    const intentId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5051";
    await expect(connector.uploadAttachment({
      ...scope,
      threadId,
      command: {
        intentId,
        requestHash: requestHash(intentId),
        attachmentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5052",
        messageId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5053",
        filename: "evidence.txt",
        contentType: "text/plain",
        sizeBytes: bytes.byteLength,
        contentHash: rawHash(bytes),
        purpose: "evidence"
      },
      source: {
        sizeBytes: bytes.byteLength,
        async *read() {
          sourceReads += 1;
          yield bytes;
        }
      }
    })).rejects.toMatchObject({ code: "feedback.not_found", status: 404 });
    expect(provider.uploadCalls).toBe(0);
    expect(sourceReads).toBe(0);
  });

  it("legacyとvalid v2の差異はwarning付きでv2優先、invalid v2はlegacyへfallbackしない", async () => {
    const provider = new MemoryRedmine();
    const connector = repository(provider);
    await connector.createThread({ ...scope, command: createCommand() });
    await connector.reply({
      ...scope,
      threadId,
      command: { intentId: replyIntentId, requestHash: requestHash(replyIntentId), messageId, body: "署名済み本文" }
    });
    const issue = provider.onlyIssue();
    const journal = (issue.journals as Array<{ notes: string }>)[0]!;
    const parsed = parseRedmineMessageNote(journal.notes)!;
    journal.notes = buildDualWriteRedmineNote(parsed.body, {
      ...parsed.metadata,
      messageId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5099"
    });
    const mapped = await mapRedmineIssue(issue, profile, scope, codec);
    expect(mapped.thread.messages.some((item) => item.messageId === messageId)).toBe(true);
    expect(mapped.warnings).toHaveLength(1);

    const envelopeField = (issue.custom_fields as Array<{ id: number; value: string }>).find((field) => field.id === ids.envelope)!;
    const envelope = JSON.parse(envelopeField.value) as { signature: { value: string } };
    envelope.signature.value = `${envelope.signature.value.slice(0, -1)}${envelope.signature.value.endsWith("A") ? "B" : "A"}`;
    envelopeField.value = JSON.stringify(envelope);
    await expect(mapRedmineIssue(issue, profile, scope, codec)).rejects.toMatchObject({ code: "feedback.integrity_error" });
  });
});

function repository(provider: MemoryRedmine) {
  return createFeedbackRedmineConnector({
    profile,
    transport: provider,
    envelopeCodec: codec,
    now: () => "2026-08-31T10:00:30Z"
  });
}

function createCommand() {
  return {
    intentId: createIntentId,
    requestHash: requestHash(createIntentId),
    threadId,
    resource: scope.resource,
    title: "注文画面Feedback",
    body: "初回本文"
  };
}

function requestHash(intentId: string): string {
  return calculateFeedbackCommandHash({ operation: "fixture", intentId });
}

function rawHash(bytes: Uint8Array): string {
  // fixtureはASCII固定で、production transport側のSHA-256検証とは独立に既知vectorを使う。
  if (new TextDecoder().decode(bytes) !== "attachment") throw new Error("unexpected fixture");
  return "sha256:602a5e69c3021bdbd3d25156a02d2cbb467605b8203248eea6af3fb42168d663";
}

class MemoryRedmine implements FeedbackRedmineTransportPort {
  readonly issues = new Map<number, RedmineIssueRaw>();
  readonly firstWrites: RedmineIssueInput[] = [];
  readonly updatePhases: string[] = [];
  readonly provisionSignals: Array<FeedbackAbortSignal | undefined> = [];
  createCalls = 0;
  noteWrites = 0;
  uploadCalls = 0;
  createFailure: "before-apply" | "after-apply" | null = null;
  failPhaseBefore: "envelope" | "projection" | null = null;
  failNextNoteAfterApply = false;
  uploadFailure = false;
  tamperDownload = false;
  #nextIssueId = 100;
  #nextJournalId = 1;
  #nextAttachmentId = 500;
  #uploads = new Map<string, Uint8Array>();
  #attachmentBytes = new Map<string, Uint8Array>();

  async searchIssues(query: Parameters<FeedbackRedmineTransportPort["searchIssues"]>[0]) {
    const issues = [...this.issues.values()].filter((issue) => {
      const fields = fieldMap(issue.custom_fields as Array<{ id: number; value: unknown }>);
      return Object.entries(query.customFieldFilters).every(([id, value]) => fields.get(Number(id)) === value);
    });
    return { issues: issues.slice(query.offset, query.offset + query.limit), totalCount: issues.length, offset: query.offset, limit: query.limit };
  }

  async getIssue(issueId: number, signal?: FeedbackAbortSignal) {
    this.provisionSignals.push(signal);
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error("missing issue");
    return clone(issue);
  }

  async createIssue(issue: RedmineIssueInput) {
    this.createCalls += 1;
    this.firstWrites.push(clone(issue));
    if (this.createFailure === "before-apply") {
      this.createFailure = null;
      throw timeout();
    }
    const issueId = this.#nextIssueId++;
    this.issues.set(issueId, rawIssue(issueId, issue));
    if (this.createFailure === "after-apply") {
      this.createFailure = null;
      throw timeout();
    }
    return { issueId };
  }

  async updateIssue(issueId: number, update: RedmineIssueUpdate, signal?: FeedbackAbortSignal) {
    if (update.custom_fields?.some((field) => field.id === ids.envelope || field.id === ids.projection)) {
      this.provisionSignals.push(signal);
    }
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error("missing issue");
    const phase = update.custom_fields?.some((field) => field.id === ids.envelope) ? "envelope"
      : update.custom_fields?.some((field) => field.id === ids.projection) ? "projection" : null;
    if (phase && this.failPhaseBefore === phase) {
      this.failPhaseBefore = null;
      throw timeout();
    }
    if (update.custom_fields) {
      const fields = fieldMap(issue.custom_fields as Array<{ id: number; value: unknown }>);
      update.custom_fields.forEach((field) => fields.set(field.id, field.value));
      issue.custom_fields = [...fields].map(([id, value]) => ({ id, value }));
      if (phase) this.updatePhases.push(phase);
    }
    if (update.uploads) {
      const attachments = issue.attachments as Array<Record<string, unknown>>;
      for (const upload of update.uploads) {
        const bytes = this.#uploads.get(upload.token);
        if (!bytes) throw new Error("missing upload");
        const attachmentId = this.#nextAttachmentId++;
        attachments.push({
          id: attachmentId,
          filename: upload.filename,
          content_type: upload.content_type,
          filesize: bytes.byteLength,
          created_on: "2026-08-31T10:04:00Z",
          description: upload.description
        });
        this.#attachmentBytes.set(String(attachmentId), bytes);
      }
    }
    if (update.notes) {
      this.noteWrites += 1;
      (issue.journals as unknown[]).push({
        id: this.#nextJournalId++,
        notes: update.notes,
        created_on: `2026-08-31T10:0${this.#nextJournalId}:00Z`,
        user: { name: "Feedback integration" }
      });
      if (this.failNextNoteAfterApply) {
        this.failNextNoteAfterApply = false;
        throw timeout();
      }
    }
    issue.updated_on = "2026-08-31T10:10:00Z";
  }

  async upload(source: Parameters<FeedbackRedmineTransportPort["upload"]>[0]) {
    this.uploadCalls += 1;
    const chunks: Uint8Array[] = [];
    for await (const chunk of source.read()) chunks.push(chunk);
    const bytes = concat(chunks);
    const token = `upload-${this.uploadCalls}`;
    this.#uploads.set(token, bytes);
    if (this.uploadFailure) {
      this.uploadFailure = false;
      throw timeout();
    }
    return { token };
  }

  async downloadAttachment(providerAttachmentId: string) {
    const stored = this.#attachmentBytes.get(providerAttachmentId);
    const bytes = this.tamperDownload ? new TextEncoder().encode("tampered") : stored ?? new TextEncoder().encode(providerAttachmentId);
    return {
      filename: stored ? "evidence.txt" : "fixture.bin",
      contentType: stored ? "text/plain" : "application/octet-stream",
      sizeBytes: bytes.byteLength,
      body: (async function* () { yield bytes; })()
    };
  }

  seedIssue(command: ReturnType<typeof createCommand>): RedmineIssueRaw {
    const issueId = this.#nextIssueId++;
    const issue = rawIssue(issueId, {
      ...createIssueFromCommand(command),
      custom_fields: createIssueFromCommand(command).custom_fields
    });
    this.issues.set(issueId, issue);
    return issue;
  }

  seedLegacyIssue(extra: Partial<RedmineIssueRaw>): RedmineIssueRaw {
    const issueId = this.#nextIssueId++;
    const legacyDescription = [
      "legacy initial",
      "",
      "---",
      "Feedback metadata v1",
      `Thread ID: ${threadId}`,
      `Intent ID: ${createIntentId}`,
      `Request hash: ${requestHash(createIntentId)}`,
      `Application: ${profile.applicationKey}`,
      `Environment: ${profile.environmentKey}`,
      `External workspace: ${profile.workspaceId}`,
      `Host resource: ${scope.resource.key}`,
      `Submitted by ID: ${profile.participantId}`
    ].join("\n");
    const issue: RedmineIssueRaw = {
      id: issueId,
      subject: "legacy",
      description: legacyDescription,
      created_on: "2026-08-31T10:00:00Z",
      updated_on: "2026-08-31T10:03:00Z",
      status: { is_closed: false },
      author: { name: "Legacy user" },
      custom_fields: [
        { id: ids.threadId, value: threadId },
        { id: ids.applicationKey, value: profile.applicationKey },
        { id: ids.environmentKey, value: profile.environmentKey },
        { id: ids.externalWorkspaceKey, value: profile.workspaceId },
        { id: ids.hostResourceKey, value: scope.resource.key }
      ],
      journals: [],
      attachments: [],
      ...extra
    };
    this.issues.set(issueId, issue);
    return issue;
  }

  onlyIssue(): RedmineIssueRaw {
    return [...this.issues.values()][0]!;
  }
}

function createIssueFromCommand(command: ReturnType<typeof createCommand>): RedmineIssueInput {
  return {
    project_id: profile.projectId,
    tracker_id: profile.trackerId,
    subject: command.title,
    description: command.body,
    is_private: true,
    custom_fields: [
      { id: ids.threadId, value: command.threadId },
      { id: ids.intentId, value: command.intentId },
      { id: ids.requestHash, value: command.requestHash.slice("sha256:".length) },
      { id: ids.applicationKey, value: profile.applicationKey },
      { id: ids.environmentKey, value: profile.environmentKey },
      { id: ids.externalWorkspaceKey, value: profile.workspaceId },
      { id: ids.hostResourceKey, value: command.resource.key }
    ]
  };
}

function rawIssue(issueId: number, input: RedmineIssueInput): RedmineIssueRaw {
  return {
    id: issueId,
    subject: input.subject,
    description: input.description,
    created_on: "2026-08-31T10:00:00Z",
    updated_on: "2026-08-31T10:00:00Z",
    status: { is_closed: false },
    author: { name: "Feedback integration" },
    custom_fields: clone(input.custom_fields),
    journals: [],
    attachments: []
  };
}

function fieldMap(fields: Array<{ id: number; value: unknown }>): Map<number, unknown> {
  return new Map(fields.map((field) => [field.id, field.value]));
}

function timeout(): FeedbackConnectorProblem {
  return new FeedbackConnectorProblem({ code: "feedback.provider_timeout", status: 504, retryable: true, message: "fixture timeout" });
}

function testSignal(): FeedbackAbortSignal {
  return { aborted: false, subscribe: () => () => undefined };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  chunks.forEach((chunk) => { result.set(chunk, offset); offset += chunk.byteLength; });
  return result;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
