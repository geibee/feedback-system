import type {
  FeedbackControllerCommand,
  FeedbackControllerListener,
  FeedbackControllerPort,
  FeedbackControllerSnapshot
} from "@geibee/feedback-controller";
import { createFeedbackPlugin, type FeedbackPluginHandle } from "@geibee/feedback-web-component";

const mount = document.querySelector("#feedback-mount");
if (!(mount instanceof HTMLElement)) throw new Error("fixture mountがありません");
const threadId = "018f0f58-c3d1-7a2b-8a4f-4c09571e5001";
const commands: FeedbackControllerCommand[] = [];
let callbackCount = 0;

function initialSnapshot(): FeedbackControllerSnapshot {
  return {
    schemaVersion: "2", lifecycle: "disconnected", pluginLifecycle: "unmounted",
    profile: {
      schemaVersion: "2", profileId: "inventory-production", displayName: "Inventory / Production",
      capabilities: {
        backendOperations: ["feedback:read", "feedback:create"],
        discovery: { workspaces: "unsupported", resources: "unsupported" },
        operationGuarantees: { create: "recoverable", reply: "best-effort", revision: "best-effort", attachmentUpload: "best-effort" },
        creationFields: [], maximumAttachmentBytes: 1_048_576, attachmentContentTypes: ["image/png"]
      },
      effectivePermissions: ["feedback:read", "feedback:create"]
    },
    discovery: { state: "ready", workspaces: [], selectedWorkspaceId: "OPS", resources: [], selectedResource: { kind: "record", key: "order-001" } },
    threads: {
      state: "ready",
      items: [{
        threadId, resource: { kind: "record", key: "order-001" }, title: "vanilla browser thread", status: "open",
        createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:01:00.000Z", messageCount: 1
      }],
      nextCursor: null, selected: null, refreshing: false, error: null
    },
    localState: { draft: "", followedThreadIds: [], lastViewedByThread: {}, unreadCountByThread: { [threadId]: 1 } },
    pendingIntents: [], targetSelection: "idle", capture: "idle", navigation: null
  };
}

function createFixtureController() {
  let snapshot = initialSnapshot();
  const listeners = new Set<FeedbackControllerListener>();
  const emit = () => listeners.forEach((listener) => { callbackCount += 1; listener(snapshot); });
  const controller: FeedbackControllerPort = {
    client: {} as FeedbackControllerPort["client"],
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async dispatch(command) {
      commands.push(command);
      if (command.type === "connect") snapshot = { ...snapshot, lifecycle: "connected", pluginLifecycle: "mounted" };
      if (command.type === "update-draft") snapshot = { ...snapshot, localState: { ...snapshot.localState, draft: command.value } };
      if (command.type === "select-thread") snapshot = {
        ...snapshot,
        threads: {
          ...snapshot.threads,
          selected: {
            ...snapshot.threads.items[0]!,
            messages: [{
              messageId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5002", body: "実ブラウザの本文",
              author: { kind: "provider-user", displayName: "利用者" }, createdAt: "2026-09-01T00:00:00.000Z",
              orderingKey: { occurredAt: "2026-09-01T00:00:00.000Z", eventId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5003" },
              revisions: [], attachments: []
            }]
          }
        }
      };
      if (command.type === "destroy") {
        snapshot = { ...snapshot, lifecycle: "destroyed", pluginLifecycle: "destroyed" };
        emit();
        listeners.clear();
        return;
      }
      emit();
    }
  };
  return {
    controller,
    emitLate() {
      snapshot = { ...snapshot, localState: { ...snapshot.localState, draft: "destroy後の遅延更新" } };
      emit();
    },
    subscribers: () => listeners.size
  };
}

let fixtureController = createFixtureController();
let plugin: FeedbackPluginHandle | null = createFeedbackPlugin({
  mount,
  scope: { profileId: "inventory-production", workspaceId: "OPS", resource: { kind: "record", key: "order-001" } },
  createController: () => fixtureController.controller,
  styleNonce: "phase4"
});

window.feedbackV2Fixture = {
  commands: () => commands.map((command) => command.type),
  callbacks: () => callbackCount,
  subscribers: () => fixtureController.subscribers(),
  destroy() { plugin?.destroy(); plugin = null; },
  emitLate() { fixtureController.emitLate(); },
  remount() {
    fixtureController = createFixtureController();
    plugin = createFeedbackPlugin({
      mount,
      scope: { profileId: "inventory-production", workspaceId: "OPS", resource: { kind: "record", key: "order-001" } },
      createController: () => fixtureController.controller,
      styleNonce: "phase4"
    });
  }
};

declare global {
  interface Window {
    feedbackV2Fixture: {
      commands(): string[];
      callbacks(): number;
      subscribers(): number;
      destroy(): void;
      emitLate(): void;
      remount(): void;
    };
  }
}
