import type { RedmineThreadSummaryV1, RedmineThreadV1 } from "@geibee/feedback-contracts";
import {
  buildLocator,
  calculateRequestHash,
  serializeFeedbackContext,
  sha256Hex,
  type RedmineFeedbackContextV1,
  type TrustedFeedbackAuthor
} from "./context.js";
import { RedmineFeedbackError, contractError } from "./errors.js";
import {
  buildRedmineDescription,
  buildRedmineMessageNote,
  initialCommentFromDescription,
  parseFeedbackMetadata,
  parseRedmineMessageNote,
  replaceInitialCommentInDescription
} from "./marker.js";
import type {
  RedmineAttachmentContent,
  RedmineEvidenceMetadata,
  RedmineMessageCreateInput,
  RedmineMessageUpdateInput,
  RedmineThreadCreateInput,
  RedmineThreadFilter,
  RedmineThreadSort
} from "./model.js";
import { customFieldValue, normalizeIssueDetail, normalizeIssueSummary, sanitizeFilename } from "./normalize.js";
import type { RedmineConnectorProfile } from "./profile.js";
import { validateBaseUrl } from "./profile.js";
import { buildRedmineSubject } from "./subject.js";

export type TrustedResourceListInput = {
  scope?: "resource";
  hostResourceKey: string;
  pageKey: string;
  sort: RedmineThreadSort;
  filter?: RedmineThreadFilter;
  offset: number;
};

export type TrustedWorkspaceListInput = {
  scope: "workspace";
  sort: RedmineThreadSort;
  filter?: RedmineThreadFilter;
  offset: number;
};

export type TrustedListInput = TrustedResourceListInput | TrustedWorkspaceListInput;

export type TrustedThreadInput = {
  hostResourceKey: string;
  threadId: string;
};

export type TrustedCreateInput = Omit<RedmineThreadCreateInput, "resourceRef"> & {
  hostResourceKey: string;
  author: TrustedFeedbackAuthor;
  markerSignature?: string;
};

export type TrustedMessageCreateInput = Omit<RedmineMessageCreateInput, "resourceRef"> & {
  hostResourceKey: string;
  author: TrustedFeedbackAuthor;
  markerSignature: string;
};

export type TrustedMessageUpdateInput = Omit<RedmineMessageUpdateInput, "resourceRef"> & {
  hostResourceKey: string;
  author: TrustedFeedbackAuthor;
  markerSignature: string;
};

export type TrustedCreateResult = {
  thread: RedmineThreadV1;
  disposition: "created" | "recovered";
};

export type TrustedMutationResult = {
  thread: RedmineThreadV1;
  disposition: "created" | "recovered";
};

export type TrustedMessageOwnership = {
  kind: "initial" | "reply";
  markerKind: "initial" | "reply" | "edit";
  participantId: string;
  version: number;
  intentId: string;
  signature: string;
  body: string;
};

export type TrustedConnectionValidation = {
  user: { id: number; name: string };
  projectId: number;
  customFields: "verified" | "not-yet-proven";
};

export type RedmineFetch = (input: string, init: RequestInit) => Promise<Response>;

export type RedmineTrustedClientOptions = {
  profile: RedmineConnectorProfile;
  apiKey: string;
  fetch: RedmineFetch;
  delay?: (milliseconds: number) => Promise<void>;
  allowHttpDevelopment?: boolean;
};

type SearchMatch = {
  raw: unknown;
  summary: RedmineThreadSummaryV1;
};

export class RedmineTrustedClient {
  readonly profile: RedmineConnectorProfile;
  readonly #apiKey: string;
  readonly #fetch: RedmineFetch;
  readonly #delay: (milliseconds: number) => Promise<void>;
  readonly #baseUrl: URL;

  constructor(options: RedmineTrustedClientOptions) {
    if (!options.apiKey) throw contractError("Redmine API keyは必須です");
    this.profile = options.profile;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch;
    this.#delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#baseUrl = validateBaseUrl(options.profile.redmineBaseUrl, options.allowHttpDevelopment ?? false);
  }

  async getCurrentUser(signal?: AbortSignal): Promise<{ id: number; name: string }> {
    const value = await this.#json("GET", "users/current.json", undefined, signal, 15_000);
    const user = object(object(value, "current user response").user, "current user");
    const id = positiveInteger(user.id, "current user ID");
    const name = typeof user.firstname === "string" || typeof user.lastname === "string"
      ? `${typeof user.firstname === "string" ? user.firstname : ""} ${typeof user.lastname === "string" ? user.lastname : ""}`.trim()
      : typeof user.login === "string" ? user.login : "";
    if (!name) throw contractError("Redmine current user nameがありません");
    return { id, name };
  }

  async validateConnection(signal?: AbortSignal): Promise<TrustedConnectionValidation> {
    const user = await this.getCurrentUser(signal);
    const projectResponse = object(
      await this.#json("GET", `projects/${this.profile.projectId}.json`, undefined, signal, 15_000),
      "project response"
    );
    const project = object(projectResponse.project, "project");
    const projectId = positiveInteger(project.id, "project.id");
    if (projectId !== this.profile.projectId) throw contractError("Redmine project IDがprofileと一致しません");

    const query = this.#scopeQuery(null);
    query.set("limit", "1");
    query.set("offset", "0");
    const issueResponse = object(
      await this.#json("GET", `issues.json?${query}`, undefined, signal, 15_000),
      "connection validation issue response"
    );
    const issues = array(issueResponse.issues, "issues");
    if (issues.length > 1) throw contractError("connection validation issue listがlimitを超えています");
    if (issues.length === 0) return { user, projectId, customFields: "not-yet-proven" };
    normalizeIssueSummary(issues[0], this.profile);
    const issue = object(issues[0], "issue");
    const visibleIds = new Set(array(issue.custom_fields, "issue.custom_fields").map((field) =>
      positiveInteger(object(field, "custom field").id, "custom field id")
    ));
    const missing = Object.values(this.profile.customFieldIds).find((id) => !visibleIds.has(id));
    if (missing !== undefined) throw contractError("必須custom fieldをRedmine issue responseで確認できません");
    return { user, projectId, customFields: "verified" };
  }

  async listThreads(input: TrustedListInput, signal?: AbortSignal): Promise<{
    threads: RedmineThreadSummaryV1[];
    totalCount: number;
    nextOffset: number | null;
  }> {
    if (!Number.isInteger(input.offset) || input.offset < 0 || input.offset > 10_000) throw contractError("offsetが不正です");
    const q = input.filter?.q?.trim().toLocaleLowerCase();
    const threads: RedmineThreadSummaryV1[] = [];
    let scanOffset = input.offset;
    let totalCount = input.offset;

    while (threads.length < 50 && scanOffset <= 10_000) {
      const query = input.scope === "workspace"
        ? this.#scopeQuery(null)
        : this.#scopeQuery(input.hostResourceKey, input.pageKey);
      query.set("limit", "100");
      query.set("offset", String(scanOffset));
      query.set("sort", sortValue(input.sort));
      applyFilters(query, input.filter, this.profile);
      const value = object(await this.#json("GET", `issues.json?${query}`, undefined, signal, 15_000), "issue list response");
      const issues = array(value.issues, "issues");
      totalCount = nonnegativeInteger(value.total_count, "total_count");
      if (issues.length > 100) throw contractError("Redmine issue listがlimitを超えています");
      if (issues.length === 0) {
        if (scanOffset < totalCount) throw contractError("Redmine issue list paginationが不整合です");
        break;
      }

      let consumed = 0;
      for (const issue of issues) {
        const thread = normalizeIssueSummary(issue, this.profile);
        consumed += 1;
        if (!q || `${thread.subject}\n${thread.initialComment}`.toLocaleLowerCase().includes(q)) threads.push(thread);
        if (threads.length === 50) break;
      }
      scanOffset += consumed;
      if (scanOffset >= totalCount) break;
    }

    return {
      threads,
      totalCount,
      nextOffset: scanOffset < totalCount && scanOffset <= 10_000 ? scanOffset : null
    };
  }

  async getThread(input: TrustedThreadInput, signal?: AbortSignal, participantId: string | null = null): Promise<RedmineThreadV1> {
    const match = await this.#oneThread(input, signal);
    return this.#issueDetail(match.summary.issueId, input.threadId, signal, participantId);
  }

  async lookupThreadAuthorization(threadId: string, signal?: AbortSignal): Promise<{
    issueId: number;
    hostResourceKey: string;
  }> {
    const matches = await this.#searchThreadByProfile(threadId, null, signal);
    if (matches.length === 0) throw new RedmineFeedbackError("redmine.not_found", "threadが見つかりません", { upstreamStatus: 404 });
    if (matches.length > 1) throw new RedmineFeedbackError("redmine.duplicate_thread_id", "同じthread IDのissueが複数あります", { upstreamStatus: 409 });
    const fields = object(matches[0]!.raw, "issue").custom_fields;
    const hostResourceKey = customFieldValue(fields, this.profile.customFieldIds.hostResourceKey);
    if (!hostResourceKey) throw contractError("threadにhost resource keyがありません");
    return { issueId: matches[0]!.summary.issueId, hostResourceKey };
  }

  async createThread(
    input: TrustedCreateInput,
    evidenceBytes: Uint8Array | null,
    signal?: AbortSignal
  ): Promise<RedmineThreadV1> {
    return (await this.createThreadWithDisposition(input, evidenceBytes, signal)).thread;
  }

  async createThreadWithDisposition(
    input: TrustedCreateInput,
    evidenceBytes: Uint8Array | null,
    signal?: AbortSignal
  ): Promise<TrustedCreateResult> {
    validateUuid(input.threadId, "thread ID");
    validateUuid(input.intentId, "intent ID");
    const evidenceSha256 = evidenceBytes ? await sha256Hex(evidenceBytes) : null;
    validateEvidence(
      input.evidence,
      evidenceBytes,
      evidenceSha256,
      this.profile.clientProfile.capture.maximumUploadBytes,
      this.profile.clientProfile.capture.contentTypes
    );
    const requestHash = await calculateRequestHash({
      ...input,
      applicationKey: this.profile.clientProfile.applicationKey,
      environmentKey: this.profile.clientProfile.environmentKey,
      externalWorkspaceKey: this.profile.clientProfile.externalWorkspaceKey,
      pageKey: input.location.pageKey,
      comment: input.comment,
      evidenceSha256
    });
    const existing = await this.#searchThread(input.threadId, input.hostResourceKey, signal);
    if (existing.length) {
      return { thread: await this.#recover(existing, input, requestHash, signal), disposition: "recovered" };
    }

    const context: RedmineFeedbackContextV1 = {
      schemaVersion: "1",
      kind: "feedback-context",
      threadId: input.threadId,
      intentId: input.intentId,
      requestHash,
      applicationKey: this.profile.clientProfile.applicationKey,
      environmentKey: this.profile.clientProfile.environmentKey,
      externalWorkspaceKey: this.profile.clientProfile.externalWorkspaceKey,
      pageKey: input.location.pageKey,
      hostResourceKey: input.hostResourceKey,
      release: input.release,
      locale: input.locale,
      threadUrl: input.threadUrl ?? null,
      perspectiveCode: input.perspectiveCode,
      location: input.location,
      target: input.target,
      author: input.author,
      initialMessageSignature: input.markerSignature ?? null,
      capturedAt: input.capturedAt,
      primaryEvidence: input.evidence
    };
    const uploads = [{
      token: await this.#upload("feedback-context-v1.json", "application/json", serializeFeedbackContext(context), signal),
      filename: "feedback-context-v1.json",
      content_type: "application/json",
      description: "Feedback context v1"
    }];
    if (evidenceBytes && input.evidence) {
      uploads.push({
        token: await this.#upload(input.evidence.filename, input.evidence.contentType, evidenceBytes, signal),
        filename: input.evidence.filename,
        content_type: input.evidence.contentType,
        description: "Feedback primary evidence"
      });
    }
    const description = buildRedmineDescription(input.comment, input.threadUrl ?? null);
    const issue = {
      project_id: this.profile.projectId,
      tracker_id: this.profile.trackerId,
      subject: buildRedmineSubject(input),
      description,
      is_private: this.profile.isPrivate,
      ...(this.profile.defaultPriorityId === null ? {} : { priority_id: this.profile.defaultPriorityId }),
      custom_fields: this.#customFields(input, requestHash),
      uploads
    };
    try {
      await this.#json("POST", "issues.json", { issue }, signal, 60_000);
    } catch (error) {
      if (!(error instanceof RedmineFeedbackError) || !error.retryable) throw error;
      for (const wait of [200, 1_000]) {
        await this.#delay(wait);
        const recovered = await this.#searchThread(input.threadId, input.hostResourceKey, signal);
        if (recovered.length) {
          return { thread: await this.#recover(recovered, input, requestHash, signal), disposition: "recovered" };
        }
      }
      throw error;
    }
    const created = await this.#searchThread(input.threadId, input.hostResourceKey, signal);
    return { thread: await this.#recover(created, input, requestHash, signal), disposition: "created" };
  }

  async createMessageWithDisposition(
    input: TrustedMessageCreateInput,
    signal?: AbortSignal
  ): Promise<TrustedMutationResult> {
    validateUuid(input.messageId, "message ID");
    validateUuid(input.intentId, "intent ID");
    validateMessageBody(input.body, input.participantName);
    const match = await this.#oneThread(input, signal);
    const issue = await this.#issueRaw(match.summary.issueId, signal);
    this.#assertReplyOpen(issue);
    const existing = findMessageByIntent(issue, input.intentId);
    if (existing) {
      if (existing.messageId !== input.messageId || existing.participantId !== input.author.participantId) {
        throw new RedmineFeedbackError("redmine.thread_mismatch", "同じintent IDの返信内容が一致しません", { upstreamStatus: 409 });
      }
      return {
        thread: await this.#issueDetail(match.summary.issueId, input.threadId, signal, input.author.participantId),
        disposition: "recovered"
      };
    }
    const notes = buildRedmineMessageNote(input.body, {
      kind: "reply",
      messageId: input.messageId,
      participantId: input.author.participantId,
      participantName: input.participantName,
      version: 1,
      intentId: input.intentId,
      signature: input.markerSignature
    });
    await this.#json("PUT", `issues/${match.summary.issueId}.json`, { issue: { notes } }, signal, 60_000);
    return {
      thread: await this.#issueDetail(match.summary.issueId, input.threadId, signal, input.author.participantId),
      disposition: "created"
    };
  }

  async updateMessage(
    input: TrustedMessageUpdateInput,
    signal?: AbortSignal
  ): Promise<RedmineThreadV1> {
    validateUuid(input.messageId, "message ID");
    validateUuid(input.intentId, "intent ID");
    validateMessageBody(input.body, input.participantName);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw contractError("expected versionが不正です");
    const match = await this.#oneThread(input, signal);
    const issue = await this.#issueRaw(match.summary.issueId, signal);
    if (findMessageByIntent(issue, input.intentId)) {
      return this.#issueDetail(match.summary.issueId, input.threadId, signal, input.author.participantId);
    }
    const ownership = await this.#messageOwnership(issue, input.threadId, input.messageId, signal);
    if (!ownership || ownership.participantId !== input.author.participantId) {
      throw new RedmineFeedbackError("redmine.permission_denied", "自分の投稿だけを編集できます", { upstreamStatus: 403 });
    }
    if (ownership.version !== input.expectedVersion) {
      throw new RedmineFeedbackError("redmine.thread_mismatch", "投稿が更新されています。再取得してください", { upstreamStatus: 409 });
    }
    const notes = buildRedmineMessageNote(input.body, {
      kind: "edit",
      messageId: input.messageId,
      participantId: input.author.participantId,
      participantName: input.participantName,
      version: input.expectedVersion + 1,
      intentId: input.intentId,
      signature: input.markerSignature
    });
    const issueObject = object(issue, "issue");
    const update = ownership.kind === "initial"
      ? { description: replaceInitialCommentInDescription(string(issueObject.description, "issue.description"), input.body), notes }
      : { notes };
    await this.#json("PUT", `issues/${match.summary.issueId}.json`, { issue: update }, signal, 60_000);
    return this.#issueDetail(match.summary.issueId, input.threadId, signal, input.author.participantId);
  }

  async lookupMessageOwnership(
    input: TrustedThreadInput & { messageId: string },
    signal?: AbortSignal
  ): Promise<TrustedMessageOwnership | null> {
    const match = await this.#oneThread(input, signal);
    const issue = await this.#issueRaw(match.summary.issueId, signal);
    return this.#messageOwnership(issue, input.threadId, input.messageId, signal);
  }

  async getAttachment(
    input: TrustedThreadInput & { attachmentId: number },
    signal?: AbortSignal
  ): Promise<RedmineAttachmentContent> {
    const thread = await this.getThread(input, signal);
    const attachment = thread.attachments.find((candidate) => candidate.id === input.attachmentId);
    if (!attachment) throw new RedmineFeedbackError("redmine.not_found", "attachmentが見つかりません");
    const metadataResponse = object(
      await this.#json("GET", `attachments/${input.attachmentId}.json`, undefined, signal, 15_000),
      "attachment response"
    );
    const metadata = object(metadataResponse.attachment, "attachment metadata");
    const contentUrl = string(metadata.content_url, "attachment content_url");
    const target = validateAttachmentContentUrl(this.#baseUrl, contentUrl);
    const maximum = this.profile.clientProfile.attachments.maximumDownloadBytes;
    if (attachment.byteSize > maximum) {
      throw new RedmineFeedbackError("redmine.payload_too_large", "attachmentがdownload上限を超えています");
    }
    const response = await this.#raw("GET", target.toString(), undefined, signal, 120_000, false);
    const bytes = new Uint8Array(await limitedArrayBuffer(response, maximum));
    if (bytes.byteLength !== attachment.byteSize) throw contractError("attachmentのdeclared sizeと実byte数が一致しません");
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "application/octet-stream";
    if (attachment.contentType && contentType !== attachment.contentType) throw contractError("attachment content typeが一致しません");
    if (contentType === "image/png" || contentType === "image/webp") imageDimensions(bytes, contentType);
    return {
      bytes,
      filename: sanitizeFilename(attachment.filename),
      contentType,
      sha256: await sha256Hex(bytes)
    };
  }

  async #recover(
    matches: SearchMatch[],
    input: TrustedCreateInput,
    requestHash: string,
    signal?: AbortSignal
  ): Promise<RedmineThreadV1> {
    if (matches.length === 0) throw new RedmineFeedbackError("redmine.unavailable", "作成結果をRedmineから回収できません", { retryable: true });
    if (matches.length > 1) throw new RedmineFeedbackError("redmine.duplicate_thread_id", "同じthread IDのissueが複数あります", { upstreamStatus: 409 });
    const raw = matches[0]!.raw;
    const fields = object(raw, "issue").custom_fields;
    const expected = [
      [this.profile.customFieldIds.requestHash, requestHash],
      [this.profile.customFieldIds.submittedById, input.author.participantId],
      [this.profile.customFieldIds.applicationKey, this.profile.clientProfile.applicationKey],
      [this.profile.customFieldIds.environmentKey, this.profile.clientProfile.environmentKey],
      [this.profile.customFieldIds.externalWorkspaceKey, this.profile.clientProfile.externalWorkspaceKey],
      [this.profile.customFieldIds.hostResourceKey, input.hostResourceKey]
    ] as const;
    if (expected.some(([id, value]) => customFieldValue(fields, id) !== value)) {
      throw new RedmineFeedbackError("redmine.thread_mismatch", "既存threadのhash、投稿者、scopeが一致しません", { upstreamStatus: 409 });
    }
    return this.#issueDetail(matches[0]!.summary.issueId, input.threadId, signal);
  }

  async #oneThread(input: TrustedThreadInput, signal?: AbortSignal): Promise<SearchMatch> {
    const matches = await this.#searchThread(input.threadId, input.hostResourceKey, signal);
    if (matches.length === 0) throw new RedmineFeedbackError("redmine.not_found", "threadが見つかりません", { upstreamStatus: 404 });
    if (matches.length > 1) throw new RedmineFeedbackError("redmine.duplicate_thread_id", "同じthread IDのissueが複数あります", { upstreamStatus: 409 });
    return matches[0]!;
  }

  async #searchThread(threadId: string, hostResourceKey: string, signal?: AbortSignal): Promise<SearchMatch[]> {
    return this.#searchThreadByProfile(threadId, hostResourceKey, signal);
  }

  async #searchThreadByProfile(
    threadId: string,
    hostResourceKey: string | null,
    signal?: AbortSignal
  ): Promise<SearchMatch[]> {
    validateUuid(threadId, "thread ID");
    const query = this.#scopeQuery(hostResourceKey);
    query.set(`cf_${this.profile.customFieldIds.threadId}`, threadId);
    query.set("limit", "100");
    const value = object(await this.#json("GET", `issues.json?${query}`, undefined, signal, 15_000), "thread search response");
    return array(value.issues, "issues").map((raw) => ({ raw, summary: normalizeIssueSummary(raw, this.profile) }));
  }

  async #issueDetail(
    issueId: number,
    expectedThreadId: string,
    signal?: AbortSignal,
    participantId: string | null = null
  ): Promise<RedmineThreadV1> {
    const issue = await this.#issueRaw(issueId, signal);
    const url = this.profile.showRedmineLink ? this.#url(`issues/${issueId}`).toString() : null;
    const thread = normalizeIssueDetail(issue, this.profile, url, participantId);
    if (thread.threadId !== expectedThreadId) throw new RedmineFeedbackError("redmine.not_found", "threadが見つかりません");
    return thread;
  }

  async #messageOwnership(
    issue: unknown,
    threadId: string,
    messageId: string,
    signal?: AbortSignal
  ): Promise<TrustedMessageOwnership | null> {
    const legacy = findMessageOwnership(issue, threadId, messageId);
    if (legacy || messageId !== threadId) return legacy;
    const initial = await this.#initialOwnershipFromContext(issue, threadId, signal);
    return initial ? findMessageOwnership(issue, threadId, messageId, initial) : null;
  }

  async #initialOwnershipFromContext(
    issueValue: unknown,
    threadId: string,
    signal?: AbortSignal
  ): Promise<TrustedMessageOwnership | null> {
    const issue = object(issueValue, "issue");
    const attachment = (issue.attachments === undefined ? [] : array(issue.attachments, "issue.attachments"))
      .map((value) => object(value, "attachment"))
      .find((value) => value.filename === "feedback-context-v1.json");
    if (!attachment || typeof attachment.content_url !== "string") return null;
    const target = validateAttachmentContentUrl(this.#baseUrl, attachment.content_url);
    const response = await this.#raw("GET", target.toString(), undefined, signal, 15_000, true);
    const buffer = await limitedArrayBuffer(response, 1_048_576);
    let context: Record<string, unknown>;
    try {
      context = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)), "feedback context");
    } catch {
      throw contractError("feedback context attachmentが不正です");
    }
    const author = object(context.author, "feedback context author");
    const fields = issue.custom_fields;
    const expectedRequestHash = customFieldValue(fields, this.profile.customFieldIds.requestHash);
    const expectedParticipantId = customFieldValue(fields, this.profile.customFieldIds.submittedById);
    if (!expectedRequestHash || !expectedParticipantId) return null;
    if (context.schemaVersion !== "1" || context.kind !== "feedback-context" || context.threadId !== threadId ||
      context.requestHash !== expectedRequestHash || author.participantId !== expectedParticipantId ||
      typeof context.intentId !== "string" || typeof context.initialMessageSignature !== "string" ||
      !context.initialMessageSignature || context.initialMessageSignature.length > 512) return null;
    validateUuid(context.intentId, "feedback context intent ID");
    validateUuid(expectedParticipantId, "feedback context participant ID");
    return {
      kind: "initial",
      markerKind: "initial",
      participantId: expectedParticipantId,
      version: 1,
      intentId: context.intentId,
      signature: context.initialMessageSignature,
      body: initialCommentFromDescription(string(issue.description, "issue.description"))
    };
  }

  async #issueRaw(issueId: number, signal?: AbortSignal): Promise<unknown> {
    const value = object(
      await this.#json("GET", `issues/${issueId}.json?include=journals,attachments`, undefined, signal, 15_000),
      "issue detail response"
    );
    return value.issue;
  }

  #assertReplyOpen(issueValue: unknown): void {
    const closedIds = this.profile.closedStatusIds ?? [];
    if (closedIds.length === 0) return;
    const status = object(object(issueValue, "issue").status, "issue.status");
    if (closedIds.includes(positiveInteger(status.id, "issue.status.id"))) {
      throw new RedmineFeedbackError("redmine.validation_failed", "終了済みthreadへは返信できません", { upstreamStatus: 422 });
    }
  }

  async #upload(filename: string, contentType: string, bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
    const value = object(
      await this.#json(
        "POST",
        `uploads.json?filename=${encodeURIComponent(sanitizeFilename(filename))}`,
        bytes,
        signal,
        60_000,
        contentType === "application/json" ? "application/octet-stream" : "application/octet-stream"
      ),
      "upload response"
    );
    const upload = object(value.upload, "upload");
    return string(upload.token, "upload token");
  }

  #customFields(input: TrustedCreateInput, requestHash: string): Array<{ id: number; value: string }> {
    const ids = this.profile.customFieldIds;
    const values: Array<[keyof typeof ids, string]> = [
      ["threadId", input.threadId],
      ["requestHash", requestHash],
      ["applicationKey", this.profile.clientProfile.applicationKey],
      ["environmentKey", this.profile.clientProfile.environmentKey],
      ["externalWorkspaceKey", this.profile.clientProfile.externalWorkspaceKey],
      ["pageKey", input.location.pageKey],
      ["hostResourceKey", input.hostResourceKey],
      ["perspectiveCode", input.perspectiveCode],
      ["locator", buildLocator(input.location, input.target)],
      ["submittedById", input.author.participantId],
      ["submittedByName", input.author.displayName ?? ""]
    ];
    return values.map(([key, value]) => ({ id: ids[key], value }));
  }

  #scopeQuery(hostResourceKey: string | null, pageKey?: string): URLSearchParams {
    if (hostResourceKey !== null && (!hostResourceKey || hostResourceKey.length > 200)) throw contractError("host resource keyが不正です");
    const query = new URLSearchParams({
      project_id: String(this.profile.projectId),
      tracker_id: String(this.profile.trackerId),
      status_id: "*",
      [`cf_${this.profile.customFieldIds.applicationKey}`]: this.profile.clientProfile.applicationKey,
      [`cf_${this.profile.customFieldIds.environmentKey}`]: this.profile.clientProfile.environmentKey,
      [`cf_${this.profile.customFieldIds.externalWorkspaceKey}`]: this.profile.clientProfile.externalWorkspaceKey
    });
    if (hostResourceKey !== null) query.set(`cf_${this.profile.customFieldIds.hostResourceKey}`, hostResourceKey);
    if (pageKey) query.set(`cf_${this.profile.customFieldIds.pageKey}`, pageKey);
    return query;
  }

  async #json(
    method: "GET" | "POST" | "PUT",
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    timeout: number,
    contentType = "application/json"
  ): Promise<unknown> {
    const initBody: BodyInit | undefined = body === undefined
      ? undefined
      : body instanceof Uint8Array ? Uint8Array.from(body).buffer : JSON.stringify(body);
    const response = await this.#raw(method, this.#url(path).toString(), initBody, signal, timeout, method === "GET", contentType);
    if (response.status === 204 || response.headers.get("content-length") === "0") return {};
    const buffer = await limitedArrayBuffer(response, 10_485_760);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
    } catch (error) {
      throw new RedmineFeedbackError("redmine.contract_invalid", "Redmine JSON responseが不正です", { cause: error });
    }
  }

  async #raw(
    method: "GET" | "POST" | "PUT",
    url: string,
    body: BodyInit | undefined,
    signal: AbortSignal | undefined,
    timeout: number,
    retryGet: boolean,
    contentType = "application/json"
  ): Promise<Response> {
    const attempts = retryGet ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await this.#fetch(url, {
          method,
          headers: {
            Accept: "application/json",
            "X-Redmine-API-Key": this.#apiKey,
            ...(body === undefined ? {} : { "Content-Type": contentType })
          },
          body,
          redirect: "error",
          signal: controller.signal
        });
        if (response.ok) return response;
        const mapped = mapStatus(response.status);
        if (attempt + 1 < attempts && [429, 502, 503, 504].includes(response.status)) {
          await this.#delay(attempt === 0 ? 200 : 1_000);
          continue;
        }
        throw mapped;
      } catch (error) {
        if (error instanceof RedmineFeedbackError) throw error;
        if (attempt + 1 < attempts) {
          await this.#delay(attempt === 0 ? 200 : 1_000);
          continue;
        }
        throw new RedmineFeedbackError("redmine.unavailable", "Redmineへ接続できません", { retryable: true, cause: error });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    }
    throw new RedmineFeedbackError("redmine.unavailable", "Redmineへ接続できません", { retryable: true });
  }

  #url(path: string): URL {
    const base = this.#baseUrl.toString().replace(/\/?$/u, "/");
    return new URL(path.replace(/^\//u, ""), base);
  }
}

export function validateAttachmentContentUrl(baseUrl: URL, input: string): URL {
  if (input.includes("\\") || /%(?:2e|2f|5c)/iu.test(input)) throw contractError("attachment content URLが不正です");
  let parsed: URL;
  try {
    parsed = new URL(input, baseUrl);
  } catch {
    throw contractError("attachment content URLが不正です");
  }
  if (parsed.origin !== baseUrl.origin || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw contractError("attachment content URLがRedmine origin外です");
  }
  const prefix = baseUrl.pathname.endsWith("/") ? baseUrl.pathname : `${baseUrl.pathname}/`;
  if (!parsed.pathname.startsWith(prefix)) throw contractError("attachment content URLがRedmine base path外です");
  return parsed;
}

function findMessageByIntent(issueValue: unknown, intentId: string): {
  messageId: string;
  participantId: string;
} | null {
  const issue = object(issueValue, "issue");
  for (const raw of issue.journals === undefined ? [] : array(issue.journals, "issue.journals")) {
    const journal = object(raw, "journal");
    if (typeof journal.notes !== "string") continue;
    const marked = parseRedmineMessageNote(journal.notes);
    if (marked?.metadata.intentId === intentId) {
      return { messageId: marked.metadata.messageId, participantId: marked.metadata.participantId };
    }
  }
  return null;
}

function findMessageOwnership(
  issueValue: unknown,
  threadId: string,
  messageId: string,
  initialFallback: TrustedMessageOwnership | null = null
): TrustedMessageOwnership | null {
  const issue = object(issueValue, "issue");
  const description = typeof issue.description === "string" ? issue.description : "";
  const initial = parseFeedbackMetadata(description);
  const ownership = new Map<string, TrustedMessageOwnership>();
  if (initial?.participantId && initial.intentId && initial.messageSignature) {
    ownership.set(initial.messageId ?? threadId, {
      kind: "initial",
      markerKind: "initial",
      participantId: initial.participantId,
      version: 1,
      intentId: initial.intentId,
      signature: initial.messageSignature,
      body: initialCommentFromDescription(description)
    });
  } else if (initialFallback) {
    ownership.set(threadId, { ...initialFallback });
  }
  for (const raw of issue.journals === undefined ? [] : array(issue.journals, "issue.journals")) {
    const journal = object(raw, "journal");
    if (typeof journal.notes !== "string") continue;
    const marked = parseRedmineMessageNote(journal.notes);
    if (!marked) continue;
    if (marked.metadata.kind === "reply") {
      ownership.set(marked.metadata.messageId, {
        kind: "reply",
        markerKind: "reply",
        participantId: marked.metadata.participantId,
        version: marked.metadata.version,
        intentId: marked.metadata.intentId,
        signature: marked.metadata.signature,
        body: marked.body
      });
    } else {
      const current = ownership.get(marked.metadata.messageId);
      if (current && current.participantId === marked.metadata.participantId && marked.metadata.version === current.version + 1) {
        current.version = marked.metadata.version;
        current.markerKind = "edit";
        current.intentId = marked.metadata.intentId;
        current.signature = marked.metadata.signature;
        current.body = marked.body;
      }
    }
  }
  return ownership.get(messageId) ?? null;
}

function validateMessageBody(body: string, participantName: string | null): void {
  if (typeof body !== "string" || !body.trim() || body.length > 20_000) throw contractError("message bodyが不正です");
  if (participantName !== null && (typeof participantName !== "string" || !participantName.trim() || participantName.length > 100)) {
    throw contractError("participant nameが不正です");
  }
}

function validateEvidence(
  metadata: RedmineEvidenceMetadata | null,
  bytes: Uint8Array | null,
  sha256: string | null,
  maximumBytes: number,
  allowedContentTypes: readonly string[]
): void {
  if (!metadata && !bytes) return;
  if (!metadata || !bytes || !sha256) throw contractError("evidence metadataとbytesの有無が一致しません");
  if (bytes.byteLength !== metadata.byteSize || bytes.byteLength > maximumBytes) {
    throw new RedmineFeedbackError("redmine.payload_too_large", "screenshot sizeが不正です");
  }
  if (!allowedContentTypes.includes(metadata.contentType)) throw contractError("screenshot content typeがprofileで許可されていません");
  if (metadata.sha256 !== sha256) throw contractError("screenshot SHA-256が一致しません");
  const image = imageDimensions(bytes, metadata.contentType);
  const expectedWidth = Math.round(metadata.viewportWidth * metadata.pixelRatio);
  const expectedHeight = Math.round(metadata.viewportHeight * metadata.pixelRatio);
  if (image.width !== expectedWidth || image.height !== expectedHeight) {
    throw contractError("screenshot dimensionがmetadataと一致しません");
  }
}

function imageDimensions(bytes: Uint8Array, contentType: string): { width: number; height: number } {
  if (contentType === "image/png") {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 24 || signature.some((byte, index) => bytes[index] !== byte)) throw contractError("PNG bytesが不正です");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (contentType === "image/webp") {
    const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.slice(offset, offset + length));
    if (bytes.length < 30 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") throw contractError("WebP bytesが不正です");
    const chunk = ascii(12, 4);
    if (chunk === "VP8X") {
      return {
        width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)),
        height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16))
      };
    }
    if (chunk === "VP8 ") {
      return {
        width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff,
        height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff
      };
    }
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  throw contractError("対応していないscreenshot形式です");
}

async function limitedArrayBuffer(response: Response, maximum: number): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new RedmineFeedbackError("redmine.payload_too_large", "Redmine responseが上限を超えています");
  }
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      throw new RedmineFeedbackError("redmine.payload_too_large", "Redmine responseが上限を超えています");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

function applyFilters(query: URLSearchParams, filter: RedmineThreadFilter | undefined, profile: RedmineConnectorProfile): void {
  if (!filter) return;
  if (filter.status !== undefined) query.set("status_id", String(filter.status));
  if (filter.perspectiveCode) query.set(`cf_${profile.customFieldIds.perspectiveCode}`, filter.perspectiveCode);
  if (filter.assigneeId) query.set("assigned_to_id", String(filter.assigneeId));
  if (filter.priorityId) query.set("priority_id", String(filter.priorityId));
}

function sortValue(sort: RedmineThreadSort): string {
  return { created_desc: "created_on:desc", created_asc: "created_on:asc", updated_desc: "updated_on:desc" }[sort];
}

function mapStatus(status: number): RedmineFeedbackError {
  if (status === 401) return new RedmineFeedbackError("redmine.invalid_api_key", "Redmine credentialが無効です", { upstreamStatus: status });
  if (status === 403) return new RedmineFeedbackError("redmine.permission_denied", "Redmine permissionがありません", { upstreamStatus: status });
  if (status === 404) return new RedmineFeedbackError("redmine.not_found", "Redmine resourceが見つかりません", { upstreamStatus: status });
  if (status === 406) return new RedmineFeedbackError("redmine.content_type_rejected", "content typeが拒否されました", { upstreamStatus: status });
  if (status === 413) return new RedmineFeedbackError("redmine.payload_too_large", "payloadが上限を超えています", { upstreamStatus: status });
  if (status === 422) return new RedmineFeedbackError("redmine.validation_failed", "Redmine validationに失敗しました", { upstreamStatus: status });
  if (status === 429) return new RedmineFeedbackError("redmine.rate_limited", "Redmine rate limitに達しました", { upstreamStatus: status, retryable: true });
  if (status >= 500) return new RedmineFeedbackError("redmine.unavailable", "Redmineが利用できません", { upstreamStatus: status, retryable: true });
  return new RedmineFeedbackError("redmine.contract_invalid", "Redmine response statusが不正です", { upstreamStatus: status });
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw contractError(`${name}がobjectではありません`);
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw contractError(`${name}がarrayではありません`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw contractError(`${name}がpositive integerではありません`);
  return value as number;
}

function nonnegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw contractError(`${name}がnonnegative integerではありません`);
  return value as number;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw contractError(`${name}がstringではありません`);
  return value;
}

function validateUuid(value: string, name: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw contractError(`${name}がUUIDではありません`);
  }
}
