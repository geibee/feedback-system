import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  FeedbackBrowserControllerPort,
  FeedbackControllerCommand,
  FeedbackControllerListener,
  FeedbackControllerPort,
  FeedbackControllerRuntimeDependencies,
  FeedbackControllerSnapshot
} from "@geibee/feedback-controller";
import { createFeedbackController, createMemoryFeedbackControllerState } from "@geibee/feedback-controller";
import { FeedbackOverlay } from "@geibee/feedback-react";
import { FeedbackElement, defineFeedbackWebComponent, feedbackElementName } from "@geibee/feedback-web-component";
import { afterEach, describe, expect, it } from "vitest";

type Provider = "jira-cloud" | "redmine";
type Renderer = "react" | "web-component";
const threadId = "018f0f58-c3d1-7a2b-8a4f-4c09571e6301";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

for (const provider of ["jira-cloud", "redmine"] as const) {
  describe(`${provider} renderer共通provider acceptance`, () => {
    for (const renderer of ["react", "web-component"] as const) {
      it(`${renderer}は同じsnapshotとcommand suiteを満たす`, async () => {
        const fixture = controller(snapshot(provider));
        mountRenderer(renderer, fixture.value);
        click(renderer, "thread");
        click(renderer, "follow");
        click(renderer, "refresh");
        await Promise.resolve();
        expect(fixture.commands).toEqual([
          { type: "select-thread", threadId },
          { type: "follow", threadId },
          { type: "refresh" }
        ]);
      });

      it(`${renderer}は実controller／client portでwrite、recovery、File uploadを完走する`, async () => {
        const harness = createProviderHarness(provider);
        await harness.controller.dispatch({ type: "connect", scope: harness.scope });
        mountRenderer(renderer, harness.controller);

        changeText(renderer, "件名", `${provider} create`);
        changeText(renderer, "下書き", "create body");
        clickNamed(renderer, "送信");
        await waitFor(() => expect(harness.calls.filter((call) => call.method === "createThread")).toHaveLength(1));
        const create = harness.calls.find((call) => call.method === "createThread")!.query as {
          command: { threadId: string; intentId: string; requestHash: string };
        };
        expect(create.command).toMatchObject({
          threadId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
          intentId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
          requestHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
        });

        await waitFor(() => clickNamed(renderer, "結果を確認"));
        await waitFor(() => expect(harness.calls.filter((call) => call.method === "recoverIntent")).toHaveLength(1));
        const recovery = harness.calls.find((call) => call.method === "recoverIntent")!.query as {
          intentId: string; requestHash: string;
        };
        expect(recovery).toMatchObject({ intentId: create.command.intentId, requestHash: create.command.requestHash });

        click(renderer, "thread");
        await waitFor(() => expect(hasNamedButton(renderer, "返信")).toBe(true));
        changeText(renderer, "下書き", "reply body");
        clickNamed(renderer, "返信");
        await waitFor(() => expect(harness.calls.filter((call) => call.method === "reply")).toHaveLength(1));

        await waitFor(() => expect(hasNamedButton(renderer, "この投稿を編集")).toBe(true));
        clickNamed(renderer, "この投稿を編集");
        changeText(renderer, "下書き", "revised body");
        clickNamed(renderer, "変更を保存");
        await waitFor(() => expect(harness.calls.filter((call) => call.method === "appendRevision")).toHaveLength(1));

        await waitFor(() => expect(hasNamedButton(renderer, "証跡を撮影")).toBe(true));
        clickNamed(renderer, "証跡を撮影");
        await waitFor(() => expect(harness.calls.filter((call) => call.method === "uploadAttachment")).toHaveLength(1));
        expect(harness.uploadedSource).toBe(harness.fileSource);
        expect(harness.uploadedBytes).toEqual(new Uint8Array([99, 97, 112, 116, 117, 114, 101]));
      });
    }
  });
}

function mountRenderer(renderer: Renderer, controller: FeedbackControllerPort): void {
  if (renderer === "react") {
    render(<FeedbackOverlay controller={controller} defaultOpen />);
    return;
  }
  defineFeedbackWebComponent();
  const element = document.createElement(feedbackElementName) as FeedbackElement;
  element.controller = controller;
  element.open = true;
  document.body.append(element);
}

function click(renderer: Renderer, target: "thread" | "follow" | "refresh"): void {
  if (renderer === "react") {
    const names = { thread: /provider thread/u, follow: "この端末でフォロー", refresh: "更新" } as const;
    fireEvent.click(target === "follow" ? screen.getByRole("checkbox", { name: names.follow }) : screen.getByRole("button", { name: names[target] }));
    return;
  }
  const root = (document.querySelector(feedbackElementName) as FeedbackElement).shadowRoot!;
  const selectors = { thread: ".thread", follow: "input[type=checkbox]", refresh: "[data-feedback-focus=refresh]" } as const;
  (root.querySelector<HTMLElement>(selectors[target])!).click();
}

function clickNamed(renderer: Renderer, name: string): void {
  if (renderer === "react") {
    fireEvent.click(screen.getAllByRole("button", { name })[0]!);
    return;
  }
  const root = (document.querySelector(feedbackElementName) as FeedbackElement).shadowRoot!;
  const target = [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === name);
  if (!target) throw new Error(`${name} buttonがありません`);
  target.click();
}

function hasNamedButton(renderer: Renderer, name: string): boolean {
  if (renderer === "react") return screen.queryAllByRole("button", { name }).length > 0;
  const root = (document.querySelector(feedbackElementName) as FeedbackElement).shadowRoot!;
  return [...root.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent === name);
}

function changeText(renderer: Renderer, label: string, value: string): void {
  if (renderer === "react") {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    return;
  }
  const root = (document.querySelector(feedbackElementName) as FeedbackElement).shadowRoot!;
  const caption = [...root.querySelectorAll<HTMLSpanElement>("label > span")].find((item) => item.textContent === label);
  const control = caption?.parentElement?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea");
  if (!control) throw new Error(`${label} fieldがありません`);
  control.value = value;
  control.dispatchEvent(new Event("input", { bubbles: true }));
}

function controller(initial: FeedbackControllerSnapshot) {
  const listeners = new Set<FeedbackControllerListener>();
  const commands: FeedbackControllerCommand[] = [];
  const value: FeedbackControllerPort = {
    client: {} as FeedbackControllerPort["client"],
    getSnapshot: () => initial,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async dispatch(command) { commands.push(command); }
  };
  return { value, commands };
}

function snapshot(provider: Provider): FeedbackControllerSnapshot {
  return {
    schemaVersion: "2",
    lifecycle: "connected",
    pluginLifecycle: "mounted",
    profile: {
      schemaVersion: "2",
      profileId: `${provider}-acceptance`,
      displayName: `${provider} acceptance`,
      capabilities: {
        backendOperations: ["feedback:read", "feedback:create", "feedback:reply"],
        discovery: { workspaces: "supported", resources: "supported" },
        operationGuarantees: { create: "recoverable", reply: "recoverable", revision: "best-effort", attachmentUpload: "best-effort" },
        creationFields: [],
        maximumAttachmentBytes: 1024,
        attachmentContentTypes: ["text/plain"]
      },
      effectivePermissions: ["feedback:read", "feedback:create", "feedback:reply"]
    },
    discovery: {
      state: "ready",
      workspaces: [{ workspaceId: "FBT", displayName: "Feedback" }],
      selectedWorkspaceId: "FBT",
      resources: [{ resource: { kind: "record", key: "acceptance" }, displayName: "Acceptance" }],
      selectedResource: { kind: "record", key: "acceptance" }
    },
    threads: {
      state: "ready",
      items: [{
        threadId,
        resource: { kind: "record", key: "acceptance" },
        title: `${provider} provider thread`,
        status: "open",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:01.000Z",
        messageCount: 1
      }],
      nextCursor: null,
      selected: {
        threadId,
        resource: { kind: "record", key: "acceptance" },
        title: `${provider} provider thread`,
        status: "open",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:01.000Z",
        messageCount: 1,
        messages: []
      },
      refreshing: false,
      error: null
    },
    localState: { draft: "", followedThreadIds: [], lastViewedByThread: {}, unreadCountByThread: { [threadId]: 1 } },
    pendingIntents: [],
    targetSelection: "idle",
    capture: "idle",
    navigation: null
  };
}

type ClientPort = FeedbackControllerRuntimeDependencies["client"];
type ClientCall = { method: keyof ClientPort; query: unknown };

function createProviderHarness(provider: Provider) {
  const scope = {
    profileId: `${provider}-acceptance`, workspaceId: "FBT",
    resource: { kind: "record", key: "acceptance" }
  } as const;
  const calls: ClientCall[] = [];
  const ownMessageId = "018f0f58-c3d1-7a2b-8a4f-4c09571e6401";
  const bytes = new Uint8Array([99, 97, 112, 116, 117, 114, 101]);
  const file = new File([bytes], "capture.txt", { type: "text/plain" });
  const fileSource = {
    file,
    sizeBytes: file.size,
    async *stream() { yield bytes; }
  };
  let uploadedSource: unknown;
  let uploadedBytes = new Uint8Array();
  let pendingCreate: { intentId: string; requestHash: string; threadId: string } | null = null;
  let currentThread = acceptanceThread(provider, ownMessageId);
  const record = (method: keyof ClientPort, query: unknown) => { calls.push({ method, query }); };
  const client: ClientPort = {
    async issueParticipant(query) {
      record("issueParticipant", query);
      return { participantId: "018f0f58-c3d1-7a2b-8a4f-4c09571e6490", credential: "fixture-credential" };
    },
    async getProfile(query) {
      record("getProfile", query);
      return acceptanceProfile(provider);
    },
    async listWorkspaces(query) {
      record("listWorkspaces", query);
      return { items: [{ workspaceId: "FBT", displayName: "Feedback" }], nextCursor: null };
    },
    async listResources(query) {
      record("listResources", query);
      return { items: [{ resource: scope.resource, displayName: "Acceptance" }], nextCursor: null };
    },
    async listThreads(query) {
      record("listThreads", query);
      const { messages: _messages, ...summary } = currentThread;
      return { items: [summary], nextCursor: null };
    },
    async getThread(query) {
      record("getThread", query);
      return currentThread;
    },
    async createThread(query) {
      record("createThread", query);
      pendingCreate = {
        intentId: query.command.intentId,
        requestHash: query.command.requestHash,
        threadId: query.command.threadId
      };
      return {
        intentId: query.command.intentId,
        state: "pending",
        operation: "feedback:create",
        retryAfterSeconds: 1,
        automaticWriteAllowed: false
      };
    },
    async recoverIntent(query) {
      record("recoverIntent", query);
      if (!pendingCreate || query.intentId !== pendingCreate.intentId || query.requestHash !== pendingCreate.requestHash) {
        return {
          intentId: query.intentId,
          state: "repair_required",
          operation: query.operation,
          detail: "binding mismatch",
          automaticWriteAllowed: false,
          retryDirective: "do-not-write"
        };
      }
      return {
        intentId: query.intentId,
        state: "completed",
        operation: query.operation,
        stableResultId: pendingCreate.threadId
      };
    },
    async reply(query) {
      record("reply", query);
      const message = {
        messageId: query.command.messageId,
        body: query.command.body,
        author: {
          kind: "participant" as const,
          participantId: "018f0f58-c3d1-7a2b-8a4f-4c09571e6490",
          displayName: "Acceptance participant",
          isCurrentParticipant: true
        },
        createdAt: "2026-09-01T00:02:00.000Z",
        orderingKey: { occurredAt: "2026-09-01T00:02:00.000Z", eventId: query.command.messageId },
        revisions: [{
          revisionId: query.command.messageId,
          body: query.command.body,
          revisedAt: "2026-09-01T00:02:00.000Z",
          orderingKey: { occurredAt: "2026-09-01T00:02:00.000Z", eventId: query.command.messageId }
        }],
        attachments: []
      };
      currentThread = { ...currentThread, messages: [...currentThread.messages, message], messageCount: currentThread.messageCount + 1 };
      return { disposition: "created", intentId: query.command.intentId, message };
    },
    async appendRevision(query) {
      record("appendRevision", query);
      const existing = currentThread.messages.find((message) => message.messageId === query.messageId)!;
      const revision = {
        revisionId: query.command.revisionId,
        body: query.command.body,
        revisedAt: "2026-09-01T00:03:00.000Z",
        orderingKey: { occurredAt: "2026-09-01T00:03:00.000Z", eventId: query.command.revisionId }
      };
      const message = { ...existing, body: query.command.body, revisions: [...existing.revisions, revision] };
      currentThread = {
        ...currentThread,
        messages: currentThread.messages.map((item) => item.messageId === query.messageId ? message : item)
      };
      return { disposition: "created", intentId: query.command.intentId, message };
    },
    async uploadAttachment(query) {
      record("uploadAttachment", query);
      uploadedSource = query.source;
      const chunks: Uint8Array[] = [];
      for await (const chunk of query.source.stream()) chunks.push(chunk);
      uploadedBytes = Uint8Array.from(chunks.flatMap((chunk) => [...chunk]));
      return {
        disposition: "created",
        intentId: query.command.intentId,
        attachment: {
          attachmentId: query.command.attachmentId,
          filename: query.command.filename,
          contentType: query.command.contentType,
          sizeBytes: query.command.sizeBytes,
          createdAt: "2026-09-01T00:04:00.000Z"
        }
      };
    },
    async getAttachment(query) {
      record("getAttachment", query);
      return { filename: "unused", contentType: "text/plain", sizeBytes: 0, body: emptyBody() };
    }
  };
  const ids = Array.from({ length: 20 }, (_unused, index) =>
    `018f0f58-c3d1-7a2b-8a4f-4c09571e${(6500 + index).toString().padStart(4, "0")}`);
  const controller = createFeedbackController({
    client,
    state: createMemoryFeedbackControllerState(),
    capture: {
      async capture() {
        return {
          filename: file.name,
          contentType: file.type,
          contentHash: `sha256:${"9".repeat(64)}`,
          source: fileSource
        };
      },
      cancel() {}
    },
    clock: { now: () => new Date("2026-09-01T00:00:00.000Z") },
    scheduler: { schedule: () => () => undefined },
    createId: () => ids.shift()!
  });
  return {
    scope,
    controller: controller as FeedbackBrowserControllerPort,
    calls,
    fileSource,
    get uploadedSource() { return uploadedSource; },
    get uploadedBytes() { return uploadedBytes; }
  };
}

function acceptanceProfile(provider: Provider): NonNullable<FeedbackControllerSnapshot["profile"]> {
  return {
    schemaVersion: "2",
    profileId: `${provider}-acceptance`,
    displayName: `${provider} acceptance`,
    capabilities: {
      backendOperations: ["feedback:read", "feedback:create", "feedback:reply", "feedback:revise", "feedback:attachment:upload"],
      discovery: { workspaces: "supported", resources: "supported" },
      operationGuarantees: { create: "recoverable", reply: "recoverable", revision: "best-effort", attachmentUpload: "best-effort" },
      creationFields: [], maximumAttachmentBytes: 1024, attachmentContentTypes: ["text/plain"]
    },
    effectivePermissions: ["feedback:read", "feedback:create", "feedback:reply", "feedback:revise", "feedback:attachment:upload"]
  };
}

function acceptanceThread(provider: Provider, messageId: string): NonNullable<FeedbackControllerSnapshot["threads"]["selected"]> {
  return {
    threadId,
    resource: { kind: "record", key: "acceptance" },
    title: `${provider} provider thread`,
    status: "open",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
    messageCount: 1,
    messages: [{
      messageId,
      body: "editable body",
      author: {
        kind: "participant", participantId: "018f0f58-c3d1-7a2b-8a4f-4c09571e6490",
        displayName: "Acceptance participant", isCurrentParticipant: true
      },
      createdAt: "2026-09-01T00:00:00.000Z",
      orderingKey: { occurredAt: "2026-09-01T00:00:00.000Z", eventId: messageId },
      revisions: [{
        revisionId: messageId, body: "editable body", revisedAt: "2026-09-01T00:00:00.000Z",
        orderingKey: { occurredAt: "2026-09-01T00:00:00.000Z", eventId: messageId }
      }], attachments: []
    }]
  };
}

async function* emptyBody(): AsyncIterable<Uint8Array> { /* empty fixture */ }
