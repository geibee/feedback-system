import type {
  FeedbackIntentRecoveryResultV2,
  FeedbackMessageV2,
  FeedbackOrderingKeyV2,
  FeedbackProblemV2,
  FeedbackThreadSummaryV2,
  FeedbackThreadV2
} from "@geibee/feedback-contracts/v2";
import {
  FeedbackClientProblem,
  type FeedbackAbortSignal,
  type FeedbackRequestOptions,
  type FeedbackScopedQuery
} from "@geibee/feedback-client";
import type {
  FeedbackControllerCommand,
  FeedbackBrowserControllerPort,
  FeedbackCapturedEvidence,
  FeedbackControllerListener,
  FeedbackControllerLocalState,
  FeedbackControllerPendingStatePort,
  FeedbackControllerPort,
  FeedbackControllerRuntimeDependencies,
  FeedbackControllerSnapshot,
  FeedbackControllerWriteCommand,
  FeedbackControllerWriteInput,
  FeedbackPendingIntentSnapshot
} from "./index.js";

const feedbackCommandDomainSeparator = "feedback-command\n2\n";
const stableIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const requestHashPattern = /^sha256:[a-f0-9]{64}$/u;

const emptyLocalState = (): FeedbackControllerLocalState => ({
  draft: "",
  followedThreadIds: [],
  lastViewedByThread: {},
  unreadCountByThread: {}
});

const initialSnapshot = (): FeedbackControllerSnapshot => ({
  schemaVersion: "2",
  lifecycle: "disconnected",
  pluginLifecycle: "unmounted",
  profile: null,
  discovery: {
    state: "idle",
    workspaces: [],
    selectedWorkspaceId: null,
    resources: [],
    selectedResource: null
  },
  threads: {
    state: "idle",
    items: [],
    nextCursor: null,
    selected: null,
    refreshing: false,
    error: null
  },
  localState: emptyLocalState(),
  pendingIntents: [],
  targetSelection: "idle",
  capture: "idle",
  navigation: null
});

class ControllerAbortSignal implements FeedbackAbortSignal {
  aborted = false;
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const listener of [...this.listeners]) listener();
    this.listeners.clear();
  }
}

export function createFeedbackController(dependencies: FeedbackControllerRuntimeDependencies): FeedbackBrowserControllerPort {
  const listeners = new Set<FeedbackControllerListener>();
  const activeSignals = new Set<ControllerAbortSignal>();
  const pollingInterval = dependencies.pollingIntervalMilliseconds ?? 30_000;
  if (!Number.isSafeInteger(pollingInterval) || pollingInterval < 1_000 || pollingInterval > 300_000) {
    throw new Error("pollingIntervalMillisecondsは1,000〜300,000で指定してください");
  }
  let snapshot = initialSnapshot();
  let currentScope: FeedbackScopedQuery | null = null;
  let sessionGeneration = 0;
  let threadsGeneration = 0;
  let selectionGeneration = 0;
  let captureGeneration = 0;
  let navigationGeneration = 0;
  let capturedEvidence: FeedbackCapturedEvidence | null = null;
  let cancelPoll: (() => void) | null = null;
  let destroyed = false;
  const pendingState = isPendingStatePort(dependencies.state) ? dependencies.state : null;
  const requestHash = dependencies.requestHash ?? { calculate: calculateBrowserFeedbackRequestHash };

  const emit = () => {
    if (destroyed) return;
    for (const listener of [...listeners]) {
      try { listener(snapshot); } catch { /* renderer callbackはstate machineを停止させない */ }
    }
  };
  const replace = (next: FeedbackControllerSnapshot) => { snapshot = next; emit(); };
  const update = (change: Partial<FeedbackControllerSnapshot>) => replace({ ...snapshot, ...change });
  const isCurrentSession = (generation: number) => !destroyed && generation === sessionGeneration;
  const createSignal = (): { signal: ControllerAbortSignal; options: FeedbackRequestOptions; finish(): void } => {
    const signal = new ControllerAbortSignal();
    activeSignals.add(signal);
    return { signal, options: { signal }, finish: () => activeSignals.delete(signal) };
  };
  const abortOperations = () => {
    for (const signal of [...activeSignals]) signal.abort();
    activeSignals.clear();
  };
  const setProblem = (error: unknown) => {
    if (destroyed) return;
    const problem = error instanceof FeedbackClientProblem
      ? error.problem
      : isProblem(error)
        ? error
        : localProblem("feedback.provider_unavailable", "Feedback操作に失敗しました", true);
    update({ threads: { ...snapshot.threads, state: "error", refreshing: false, error: problem } });
  };
  const saveLocal = async () => {
    const profileId = snapshot.profile?.profileId;
    if (!profileId) return;
    try { await dependencies.state.save(profileId, snapshot.localState); } catch (error) { setProblem(error); }
  };
  const savePending = async () => {
    const profileId = snapshot.profile?.profileId;
    if (!profileId || !pendingState) return;
    try { await pendingState.savePendingIntents(profileId, snapshot.pendingIntents); } catch (error) { setProblem(error); }
  };
  const visibility = dependencies.visibility ?? { isVisible: () => true, subscribe: () => () => undefined };
  const stopPolling = () => { cancelPoll?.(); cancelPoll = null; };
  const schedulePolling = () => {
    stopPolling();
    if (destroyed || snapshot.lifecycle !== "connected" || !visibility.isVisible()) return;
    cancelPoll = dependencies.scheduler.schedule(pollingInterval, () => {
      cancelPoll = null;
      if (destroyed || snapshot.lifecycle !== "connected" || !visibility.isVisible()) return;
      void dispatch({ type: "refresh" }).finally(schedulePolling);
    });
  };
  const visibilityUnsubscribe = visibility.subscribe((visible) => {
    if (destroyed || snapshot.lifecycle !== "connected") return;
    if (!visible) stopPolling();
    else {
      stopPolling();
      void dispatch({ type: "refresh" }).finally(schedulePolling);
    }
  });

  const refreshFollowed = async (
    scope: FeedbackScopedQuery,
    state: FeedbackControllerLocalState,
    options: FeedbackRequestOptions
  ): Promise<FeedbackControllerLocalState> => {
    const followed = state.followedThreadIds.slice(0, 100);
    const details = await Promise.all(followed.map(async (threadId) => {
      try { return await dependencies.client.getThread({ ...scope, threadId }, options); } catch { return null; }
    }));
    let next = cloneLocalState(state);
    for (const detail of details) {
      if (!detail) continue;
      const latest = latestOrdering(detail);
      if (!latest) continue;
      const previous = next.lastViewedByThread[detail.threadId];
      if (!previous) {
        next = {
          ...next,
          lastViewedByThread: { ...next.lastViewedByThread, [detail.threadId]: latest },
          unreadCountByThread: { ...next.unreadCountByThread, [detail.threadId]: 0 }
        };
        continue;
      }
      next = {
        ...next,
        unreadCountByThread: { ...next.unreadCountByThread, [detail.threadId]: countUnread(detail, previous) }
      };
    }
    return next;
  };

  const connect = async (scope: FeedbackScopedQuery) => {
    abortOperations();
    stopPolling();
    const generation = ++sessionGeneration;
    threadsGeneration += 1;
    selectionGeneration += 1;
    currentScope = { ...scope, resource: { ...scope.resource } };
    update({
      lifecycle: "connecting",
      pluginLifecycle: "mounted",
      discovery: { ...snapshot.discovery, state: "loading", selectedWorkspaceId: scope.workspaceId, selectedResource: scope.resource },
      threads: { ...snapshot.threads, state: "loading", refreshing: false, error: null }
    });
    const operation = createSignal();
    try {
      const profile = await dependencies.client.getProfile(scope, operation.options);
      const [stored, storedPending, workspaces, resources, page] = await Promise.all([
        dependencies.state.load(scope.profileId),
        pendingState?.loadPendingIntents(scope.profileId) ?? Promise.resolve([]),
        profile.capabilities.discovery.workspaces === "supported"
          ? dependencies.client.listWorkspaces({ profileId: scope.profileId }, operation.options)
          : Promise.resolve({ items: [], nextCursor: null }),
        profile.capabilities.discovery.resources === "supported"
          ? dependencies.client.listResources({ profileId: scope.profileId, workspaceId: scope.workspaceId }, operation.options)
          : Promise.resolve({ items: [], nextCursor: null }),
        dependencies.client.listThreads(scope, operation.options)
      ]);
      const localState = await refreshFollowed(scope, stored ?? emptyLocalState(), operation.options);
      if (!isCurrentSession(generation) || operation.signal.aborted) return;
      replace({
        ...snapshot,
        lifecycle: "connected",
        pluginLifecycle: "mounted",
        profile,
        discovery: {
          state: "ready",
          workspaces: workspaces.items,
          selectedWorkspaceId: scope.workspaceId,
          resources: resources.items,
          selectedResource: scope.resource
        },
        threads: {
          state: "ready",
          items: page.items,
          nextCursor: page.nextCursor,
          selected: null,
          refreshing: false,
          error: null
        },
        localState,
        pendingIntents: storedPending
      });
      await saveLocal();
      schedulePolling();
    } catch (error) {
      if (isCurrentSession(generation) && !operation.signal.aborted) {
        update({ lifecycle: "disconnected", pluginLifecycle: "unmounted" });
        setProblem(error);
      }
    } finally { operation.finish(); }
  };

  const refresh = async (append = false) => {
    const scope = currentScope;
    if (!scope || snapshot.lifecycle !== "connected") return;
    const session = sessionGeneration;
    const generation = ++threadsGeneration;
    const operation = createSignal();
    update({ threads: { ...snapshot.threads, refreshing: true, error: null } });
    try {
      const page = await dependencies.client.listThreads({
        ...scope,
        ...(append ? { cursor: snapshot.threads.nextCursor ?? undefined } : {})
      }, operation.options);
      const localState = await refreshFollowed(scope, snapshot.localState, operation.options);
      if (!isCurrentSession(session) || generation !== threadsGeneration || operation.signal.aborted) return;
      const items = append ? mergeThreadSummaries(snapshot.threads.items, page.items) : page.items;
      update({
        threads: { ...snapshot.threads, state: "ready", items, nextCursor: page.nextCursor, refreshing: false, error: null },
        localState
      });
      await saveLocal();
    } catch (error) {
      if (isCurrentSession(session) && generation === threadsGeneration && !operation.signal.aborted) setProblem(error);
    } finally { operation.finish(); }
  };

  const selectThread = async (threadId: string) => {
    const scope = currentScope;
    if (!scope || snapshot.lifecycle !== "connected") return;
    const session = sessionGeneration;
    const generation = ++selectionGeneration;
    const operation = createSignal();
    update({ threads: { ...snapshot.threads, state: "loading", error: null } });
    try {
      const thread = await dependencies.client.getThread({ ...scope, threadId }, operation.options);
      if (!isCurrentSession(session) || generation !== selectionGeneration || operation.signal.aborted) return;
      const latest = latestOrdering(thread);
      const localState = latest ? {
        ...snapshot.localState,
        lastViewedByThread: { ...snapshot.localState.lastViewedByThread, [threadId]: latest },
        unreadCountByThread: { ...snapshot.localState.unreadCountByThread, [threadId]: 0 }
      } : snapshot.localState;
      update({ threads: { ...snapshot.threads, state: "ready", selected: thread, error: null }, localState });
      await saveLocal();
    } catch (error) {
      if (isCurrentSession(session) && generation === selectionGeneration && !operation.signal.aborted) setProblem(error);
    } finally { operation.finish(); }
  };

  const recordPending = async (
    scope: FeedbackScopedQuery,
    threadId: string,
    stableResultId: string,
    intentId: string,
    operation: FeedbackPendingIntentSnapshot["operation"],
    requestHash: string,
    recovery: FeedbackIntentRecoveryResultV2
  ) => {
    const pending: FeedbackPendingIntentSnapshot = {
      scope,
      threadId,
      stableResultId,
      intentId,
      operation,
      requestHash,
      recovery,
      retryPolicy: recovery.state === "repair_required" && recovery.retryDirective === "manual-confirmation"
        ? "manual-confirmation"
        : "recover-only"
    };
    update({ pendingIntents: [...snapshot.pendingIntents.filter((item) => item.intentId !== intentId), pending] });
    await savePending();
  };

  const uncertainRecovery = (
    intentId: string,
    operation: FeedbackPendingIntentSnapshot["operation"],
    error: FeedbackClientProblem
  ): FeedbackIntentRecoveryResultV2 => ({
    intentId,
    state: "pending",
    operation,
    retryAfterSeconds: Math.min(300, Math.max(1, error.problem.retryAfterSeconds ?? 5)),
    automaticWriteAllowed: false
  });

  const executeWrite = async (input: {
    scope: FeedbackScopedQuery;
    threadId: string;
    stableResultId: string;
    intentId: string;
    requestHash: string;
    operation: FeedbackPendingIntentSnapshot["operation"];
    run(options: FeedbackRequestOptions): Promise<unknown>;
    complete(result: unknown): Promise<void>;
  }) => {
    const session = sessionGeneration;
    const operation = createSignal();
    try {
      const result = await input.run(operation.options);
      if (!isCurrentSession(session) || operation.signal.aborted) return;
      if (isRecovery(result)) {
        if (result.intentId !== input.intentId || result.operation !== input.operation) {
          setProblem(localProblem("feedback.integrity_error", "intent回収結果のbindingが一致しません", false));
        } else if (result.state === "completed") {
          update({ pendingIntents: snapshot.pendingIntents.filter((item) => item.intentId !== input.intentId) });
          await savePending();
          await refresh(false);
        } else {
          await recordPending(input.scope, input.threadId, input.stableResultId, input.intentId, input.operation, input.requestHash, result);
        }
      }
      else {
        update({ pendingIntents: snapshot.pendingIntents.filter((item) => item.intentId !== input.intentId) });
        await savePending();
        await input.complete(result);
      }
    } catch (error) {
      if (!isCurrentSession(session) || operation.signal.aborted) return;
      if (error instanceof FeedbackClientProblem && error.problem.retryable) {
        await recordPending(input.scope, input.threadId, input.stableResultId, input.intentId, input.operation, input.requestHash,
          uncertainRecovery(input.intentId, input.operation, error));
      } else setProblem(error);
    } finally { operation.finish(); }
  };

  const createWriteCommand = async (input: FeedbackControllerWriteInput): Promise<FeedbackControllerWriteCommand> => {
    const scope = currentScope;
    const activeProfile = snapshot.profile;
    if (!scope || !activeProfile || snapshot.lifecycle !== "connected") {
      throw new Error("Feedbackへ接続してから投稿してください");
    }
    const calculate = async (value: unknown): Promise<string> => {
      const valueHash = await requestHash.calculate(value);
      if (!requestHashPattern.test(valueHash)) throw new Error("request hash生成結果が不正です");
      return valueHash;
    };
    const createId = (name: string): string => {
      const value = dependencies.createId();
      if (!stableIdPattern.test(value)) throw new Error(`${name}生成結果がUUIDではありません`);
      return value;
    };

    switch (input.type) {
      case "submit": {
        requireOperation(activeProfile, "feedback:create");
        assertText(input.title, "title", 300);
        assertText(input.body, "body", 100_000);
        const threadId = createId("threadId");
        const intentId = createId("intentId");
        const hashInput = {
          operation: "feedback:create",
          profileId: scope.profileId,
          workspaceId: scope.workspaceId,
          resource: scope.resource,
          command: { intentId, threadId, title: input.title, body: input.body }
        };
        return {
          type: "submit",
          profileId: scope.profileId,
          workspaceId: scope.workspaceId,
          command: { ...hashInput.command, requestHash: await calculate(hashInput), resource: { ...scope.resource } }
        };
      }
      case "reply": {
        requireOperation(activeProfile, "feedback:reply");
        assertStableId(input.threadId, "threadId");
        assertText(input.body, "body", 100_000);
        const messageId = createId("messageId");
        const intentId = createId("intentId");
        const commandWithoutHash = { intentId, messageId, body: input.body };
        const hashInput = { operation: "feedback:reply", ...scope, threadId: input.threadId, command: commandWithoutHash };
        return {
          type: "reply", scope: cloneScope(scope), threadId: input.threadId,
          command: { ...commandWithoutHash, requestHash: await calculate(hashInput) }
        };
      }
      case "revise": {
        requireOperation(activeProfile, "feedback:revise");
        assertStableId(input.threadId, "threadId");
        assertStableId(input.messageId, "messageId");
        assertStableId(input.expectedRevisionId, "expectedRevisionId");
        assertText(input.body, "body", 100_000);
        const revisionId = createId("revisionId");
        const intentId = createId("intentId");
        const commandWithoutHash = {
          intentId, revisionId, body: input.body, expectedRevisionId: input.expectedRevisionId
        };
        const hashInput = {
          operation: "feedback:revise", ...scope, threadId: input.threadId,
          messageId: input.messageId, command: commandWithoutHash
        };
        return {
          type: "revise", scope: cloneScope(scope), threadId: input.threadId, messageId: input.messageId,
          command: { ...commandWithoutHash, requestHash: await calculate(hashInput) }
        };
      }
      case "upload-attachment": {
        requireOperation(activeProfile, "feedback:attachment:upload");
        assertStableId(input.threadId, "threadId");
        if (input.messageId !== undefined) assertStableId(input.messageId, "messageId");
        const evidence = capturedEvidence;
        if (!evidence) throw new Error("uploadする証跡がありません");
        assertText(evidence.filename, "filename", 255);
        assertText(evidence.contentType, "contentType", 200);
        if (!requestHashPattern.test(evidence.contentHash)) throw new Error("contentHashが不正です");
        if (!Number.isSafeInteger(evidence.source.sizeBytes) || evidence.source.sizeBytes < 1 ||
          evidence.source.sizeBytes > activeProfile.capabilities.maximumAttachmentBytes) {
          throw new Error("attachment sizeがprofileの許可範囲外です");
        }
        if (!activeProfile.capabilities.attachmentContentTypes.includes(evidence.contentType)) {
          throw new Error("attachment content typeがprofileで許可されていません");
        }
        const attachmentId = createId("attachmentId");
        const intentId = createId("intentId");
        const commandWithoutHash = {
          intentId,
          attachmentId,
          ...(input.messageId ? { messageId: input.messageId } : {}),
          filename: evidence.filename,
          contentType: evidence.contentType,
          sizeBytes: evidence.source.sizeBytes,
          contentHash: evidence.contentHash,
          purpose: input.purpose ?? "evidence" as const
        };
        const hashInput = {
          operation: "feedback:attachment:upload", ...scope, threadId: input.threadId, command: commandWithoutHash
        };
        return {
          type: "upload-attachment", scope: cloneScope(scope), threadId: input.threadId,
          command: { ...commandWithoutHash, requestHash: await calculate(hashInput) }, source: evidence.source
        };
      }
    }
  };

  const dispatch = async (command: FeedbackControllerCommand): Promise<void> => {
    if (destroyed) return;
    switch (command.type) {
      case "connect": await connect(command.scope); return;
      case "refresh": await refresh(false); return;
      case "load-more": if (snapshot.threads.nextCursor) await refresh(true); return;
      case "select-workspace": {
        if (!snapshot.profile || snapshot.lifecycle !== "connected") return;
        const session = sessionGeneration;
        const operation = createSignal();
        update({ discovery: { ...snapshot.discovery, state: "loading", selectedWorkspaceId: command.workspaceId, selectedResource: null, resources: [] } });
        try {
          const page = await dependencies.client.listResources({ profileId: snapshot.profile.profileId, workspaceId: command.workspaceId }, operation.options);
          if (!isCurrentSession(session) || operation.signal.aborted) return;
          update({ discovery: { ...snapshot.discovery, state: "ready", resources: page.items } });
        } catch (error) { if (isCurrentSession(session) && !operation.signal.aborted) setProblem(error); }
        finally { operation.finish(); }
        return;
      }
      case "select-resource": {
        if (!snapshot.profile || !snapshot.discovery.selectedWorkspaceId) return;
        currentScope = {
          profileId: snapshot.profile.profileId,
          workspaceId: snapshot.discovery.selectedWorkspaceId,
          resource: command.resource
        };
        update({ discovery: { ...snapshot.discovery, selectedResource: command.resource } });
        await refresh(false);
        return;
      }
      case "select-thread": await selectThread(command.threadId); return;
      case "follow": {
        let local = cloneLocalState(snapshot.localState);
        local = { ...local, followedThreadIds: [...new Set([...local.followedThreadIds, command.threadId])].sort() };
        const selected = snapshot.threads.selected?.threadId === command.threadId ? snapshot.threads.selected : null;
        const latest = selected ? latestOrdering(selected) : null;
        if (latest) local = {
          ...local,
          lastViewedByThread: { ...local.lastViewedByThread, [command.threadId]: latest },
          unreadCountByThread: { ...local.unreadCountByThread, [command.threadId]: 0 }
        };
        update({ localState: local });
        await saveLocal();
        return;
      }
      case "unfollow": {
        const unread = { ...snapshot.localState.unreadCountByThread };
        delete unread[command.threadId];
        update({ localState: {
          ...snapshot.localState,
          followedThreadIds: snapshot.localState.followedThreadIds.filter((id) => id !== command.threadId),
          unreadCountByThread: unread
        } });
        await saveLocal();
        return;
      }
      case "update-draft": update({ localState: { ...snapshot.localState, draft: command.value } }); await saveLocal(); return;
      case "begin-target-selection": update({ targetSelection: "selecting" }); return;
      case "cancel-target-selection": update({ targetSelection: "cancelled" }); return;
      case "begin-evidence-capture": {
        const session = sessionGeneration;
        const generation = ++captureGeneration;
        capturedEvidence = null;
        update({ capture: "capturing" });
        try {
          const evidence = await dependencies.capture.capture();
          if (isCurrentSession(session) && generation === captureGeneration) {
            capturedEvidence = evidence;
            update({ capture: "captured" });
          }
        } catch (error) {
          if (isCurrentSession(session) && generation === captureGeneration) {
            update({ capture: "cancelled" });
            setProblem(error);
          }
        }
        return;
      }
      case "cancel-evidence-capture": captureGeneration += 1; capturedEvidence = null; dependencies.capture.cancel(); update({ capture: "cancelled" }); return;
      case "submit": {
        const scope = { profileId: command.profileId, workspaceId: command.workspaceId, resource: command.command.resource };
        assertActiveWrite(scope, "feedback:create", snapshot, currentScope);
        await executeWrite({
          scope, threadId: command.command.threadId, stableResultId: command.command.threadId,
          intentId: command.command.intentId, requestHash: command.command.requestHash, operation: "feedback:create",
          run: (options) => dependencies.client.createThread({ profileId: command.profileId, workspaceId: command.workspaceId, command: command.command }, options),
          complete: async (result) => {
            const thread = (result as { thread: FeedbackThreadV2 }).thread;
            update({
              localState: { ...snapshot.localState, draft: "" },
              threads: { ...snapshot.threads, selected: thread, items: mergeThreadSummaries(snapshot.threads.items, [toSummary(thread)]) }
            });
            await saveLocal();
          }
        });
        return;
      }
      case "reply": {
        assertActiveWrite(command.scope, "feedback:reply", snapshot, currentScope);
        await executeWrite({
          scope: command.scope, threadId: command.threadId, stableResultId: command.command.messageId,
          intentId: command.command.intentId, requestHash: command.command.requestHash, operation: "feedback:reply",
          run: (options) => dependencies.client.reply({ ...command.scope, threadId: command.threadId, command: command.command }, options),
          complete: async () => {
            update({ localState: { ...snapshot.localState, draft: "" } });
            await saveLocal();
            if (snapshot.threads.selected?.threadId === command.threadId) await selectThread(command.threadId); else await refresh(false);
          }
        });
        return;
      }
      case "revise": {
        assertActiveWrite(command.scope, "feedback:revise", snapshot, currentScope);
        await executeWrite({
          scope: command.scope, threadId: command.threadId, stableResultId: command.command.revisionId,
          intentId: command.command.intentId, requestHash: command.command.requestHash, operation: "feedback:revise",
          run: (options) => dependencies.client.appendRevision({ ...command.scope, threadId: command.threadId, messageId: command.messageId, command: command.command }, options),
          complete: async () => {
            update({ localState: { ...snapshot.localState, draft: "" } });
            await saveLocal();
            if (snapshot.threads.selected?.threadId === command.threadId) await selectThread(command.threadId); else await refresh(false);
          }
        });
        return;
      }
      case "upload-attachment": {
        assertActiveWrite(command.scope, "feedback:attachment:upload", snapshot, currentScope);
        if (capturedEvidence?.source === command.source) {
          capturedEvidence = null;
          update({ capture: "idle" });
        }
        await executeWrite({
          scope: command.scope, threadId: command.threadId, stableResultId: command.command.attachmentId,
          intentId: command.command.intentId, requestHash: command.command.requestHash, operation: "feedback:attachment:upload",
          run: (options) => dependencies.client.uploadAttachment({ ...command.scope, threadId: command.threadId, command: command.command, source: command.source }, options),
          complete: async () => { if (snapshot.threads.selected?.threadId === command.threadId) await selectThread(command.threadId); else await refresh(false); }
        });
        return;
      }
      case "recover-intent": {
        const pending = snapshot.pendingIntents.find((item) => item.intentId === command.intentId);
        if (!pending) return;
        const session = sessionGeneration;
        const operation = createSignal();
        try {
          const recovery = await dependencies.client.recoverIntent({
            ...pending.scope,
            threadId: pending.threadId,
            intentId: pending.intentId,
            requestHash: pending.requestHash,
            operation: pending.operation
          }, operation.options);
          if (!isCurrentSession(session) || operation.signal.aborted) return;
          if (recovery.intentId !== pending.intentId || recovery.operation !== pending.operation) {
            setProblem(localProblem("feedback.integrity_error", "intent回収結果のbindingが一致しません", false));
          } else if (recovery.state === "completed") {
            update({ pendingIntents: snapshot.pendingIntents.filter((item) => item.intentId !== pending.intentId) });
            await savePending();
            await refresh(false);
          } else await recordPending(pending.scope, pending.threadId, pending.stableResultId, pending.intentId, pending.operation, pending.requestHash, recovery);
        } catch (error) { if (isCurrentSession(session) && !operation.signal.aborted) setProblem(error); }
        finally { operation.finish(); }
        return;
      }
      case "request-navigation": {
        const scope = currentScope;
        const path = snapshot.profile?.externalNavigationPath;
        if (!scope || !path || !dependencies.navigation) {
          setProblem(localProblem("feedback.unsupported", "外部navigationは利用できません", false));
          return;
        }
        const generation = ++navigationGeneration;
        const session = sessionGeneration;
        const requestId = dependencies.createId();
        update({ navigation: { requestId, path, state: "requested" } });
        try {
          const result = await dependencies.navigation.request({ requestId, path, threadId: command.threadId, scope });
          if (!isCurrentSession(session) || generation !== navigationGeneration) return;
          if (!result.locationMatches) setProblem(localProblem("feedback.invalid_request", "画面移動を完了できません", false));
        } catch (error) { if (isCurrentSession(session) && generation === navigationGeneration) setProblem(error); }
        return;
      }
      case "acknowledge-navigation": {
        if (snapshot.navigation?.requestId === command.requestId) update({ navigation: { ...snapshot.navigation, state: "acknowledged" } });
        return;
      }
      case "disconnect": {
        sessionGeneration += 1;
        threadsGeneration += 1;
        selectionGeneration += 1;
        captureGeneration += 1;
        navigationGeneration += 1;
        abortOperations();
        stopPolling();
        dependencies.capture.cancel();
        capturedEvidence = null;
        currentScope = null;
        update({ lifecycle: "disconnected", pluginLifecycle: "unmounted", capture: "cancelled" });
        return;
      }
      case "destroy": {
        sessionGeneration += 1;
        abortOperations();
        stopPolling();
        visibilityUnsubscribe();
        dependencies.capture.cancel();
        capturedEvidence = null;
        snapshot = { ...snapshot, lifecycle: "destroyed", pluginLifecycle: "destroyed" };
        for (const listener of [...listeners]) {
          try { listener(snapshot); } catch { /* destroy通知後に購読を破棄する */ }
        }
        listeners.clear();
        destroyed = true;
        currentScope = null;
        return;
      }
    }
  };

  return {
    client: dependencies.client,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (destroyed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch,
    createWriteCommand,
    getCapturedEvidence: () => capturedEvidence
  };
}

async function calculateBrowserFeedbackRequestHash(value: unknown): Promise<string> {
  const crypto = (globalThis as { crypto?: {
    subtle?: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> }
  } }).crypto;
  if (!crypto?.subtle) throw new Error("request hash生成にWeb Cryptoが必要です");
  const canonical = canonicalizeJson(value, new Set<object>());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(`${feedbackCommandDomainSeparator}${canonical}`)));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function canonicalizeJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") { assertUnicodeScalarString(value); return JSON.stringify(value); }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSONはfinite numberだけを受けます");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("canonical JSONに非JSON値があります");
  if (ancestors.has(value)) throw new TypeError("canonical JSONに循環参照があります");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key) => !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length)) {
        throw new TypeError("canonical JSON arrayに追加propertyがあります");
      }
      return `[${value.map((item) => canonicalizeJson(item, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("canonical JSONはplain objectだけを受けます");
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => {
      assertUnicodeScalarString(key);
      return `${JSON.stringify(key)}:${canonicalizeJson(object[key], ancestors)}`;
    }).join(",")}}`;
  } finally { ancestors.delete(value); }
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("lone high surrogateはcanonicalizeできません");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError("lone low surrogateはcanonicalizeできません");
  }
}

function utf8(value: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point <= 0x7f) bytes.push(point);
    else if (point <= 0x7ff) bytes.push(0xc0 | point >> 6, 0x80 | point & 0x3f);
    else if (point <= 0xffff) bytes.push(0xe0 | point >> 12, 0x80 | point >> 6 & 0x3f, 0x80 | point & 0x3f);
    else bytes.push(0xf0 | point >> 18, 0x80 | point >> 12 & 0x3f, 0x80 | point >> 6 & 0x3f, 0x80 | point & 0x3f);
  }
  return Uint8Array.from(bytes);
}

function requireOperation(
  profile: NonNullable<FeedbackControllerSnapshot["profile"]>,
  operation: "feedback:create" | "feedback:reply" | "feedback:revise" | "feedback:attachment:upload"
): void {
  if (!profile.effectivePermissions.includes(operation) || !profile.capabilities.backendOperations.includes(operation)) {
    throw new Error(`${operation}は現在の認可とprovider capabilityで許可されていません`);
  }
}

function assertActiveWrite(
  scope: FeedbackScopedQuery,
  operation: "feedback:create" | "feedback:reply" | "feedback:revise" | "feedback:attachment:upload",
  snapshot: FeedbackControllerSnapshot,
  currentScope: FeedbackScopedQuery | null
): void {
  if (snapshot.lifecycle !== "connected" || !snapshot.profile || !currentScope || !sameScope(scope, currentScope)) {
    throw new Error("write commandのscopeが現在の接続と一致しません");
  }
  requireOperation(snapshot.profile, operation);
}

function sameScope(left: FeedbackScopedQuery, right: FeedbackScopedQuery): boolean {
  return left.profileId === right.profileId && left.workspaceId === right.workspaceId &&
    left.resource.kind === right.resource.kind && left.resource.key === right.resource.key;
}

function assertStableId(value: string, name: string): void {
  if (!stableIdPattern.test(value)) throw new Error(`${name}がUUIDではありません`);
}

function assertText(value: string, name: string, maximumLength: number): void {
  if (value.length < 1 || value.length > maximumLength) throw new Error(`${name}の長さが不正です`);
  assertUnicodeScalarString(value);
}

function cloneScope(scope: FeedbackScopedQuery): FeedbackScopedQuery {
  return { profileId: scope.profileId, workspaceId: scope.workspaceId, resource: { ...scope.resource } };
}

function isRecovery(value: unknown): value is FeedbackIntentRecoveryResultV2 {
  return typeof value === "object" && value !== null && "state" in value;
}

function isPendingStatePort(value: unknown): value is FeedbackControllerPendingStatePort {
  return typeof value === "object" && value !== null &&
    typeof (value as Partial<FeedbackControllerPendingStatePort>).loadPendingIntents === "function" &&
    typeof (value as Partial<FeedbackControllerPendingStatePort>).savePendingIntents === "function";
}

function isProblem(value: unknown): value is FeedbackProblemV2 {
  return typeof value === "object" && value !== null &&
    typeof (value as Partial<FeedbackProblemV2>).code === "string" &&
    typeof (value as Partial<FeedbackProblemV2>).status === "number";
}

function compareOrdering(left: FeedbackOrderingKeyV2, right: FeedbackOrderingKeyV2): number {
  const time = left.occurredAt.localeCompare(right.occurredAt);
  return time === 0 ? left.eventId.localeCompare(right.eventId) : time;
}

function latestOrdering(thread: FeedbackThreadV2): FeedbackOrderingKeyV2 | null {
  const events = thread.messages.flatMap((message) => [message.orderingKey, ...message.revisions.map((revision) => revision.orderingKey)]);
  return events.reduce<FeedbackOrderingKeyV2 | null>((latest, event) => latest === null || compareOrdering(event, latest) > 0 ? event : latest, null);
}

function countUnread(thread: FeedbackThreadV2, viewed: FeedbackOrderingKeyV2): number {
  let count = 0;
  for (const message of thread.messages) {
    if (!isCurrentParticipant(message) && compareOrdering(message.orderingKey, viewed) > 0) count += 1;
    if (!isCurrentParticipant(message)) count += message.revisions.filter((revision) => compareOrdering(revision.orderingKey, viewed) > 0).length;
  }
  return count;
}

function isCurrentParticipant(message: FeedbackMessageV2): boolean {
  return message.author.kind === "participant" && message.author.isCurrentParticipant === true;
}

function mergeThreadSummaries(
  current: readonly FeedbackThreadSummaryV2[],
  incoming: readonly FeedbackThreadSummaryV2[]
): readonly FeedbackThreadSummaryV2[] {
  const byId = new Map(current.map((item) => [item.threadId, item]));
  for (const item of incoming) byId.set(item.threadId, item);
  return [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.threadId.localeCompare(left.threadId));
}

function toSummary(thread: FeedbackThreadV2): FeedbackThreadSummaryV2 {
  const { messages: _messages, ...summary } = thread;
  return summary;
}

function cloneLocalState(state: FeedbackControllerLocalState): FeedbackControllerLocalState {
  return {
    draft: state.draft,
    followedThreadIds: [...state.followedThreadIds],
    lastViewedByThread: Object.fromEntries(Object.entries(state.lastViewedByThread).map(([id, key]) => [id, { ...key }])),
    unreadCountByThread: { ...state.unreadCountByThread }
  };
}

function localProblem(code: FeedbackProblemV2["code"], title: string, retryable: boolean): FeedbackProblemV2 {
  return {
    type: `https://feedback.invalid/problems/${code.replace("feedback.", "")}`,
    title,
    status: code === "feedback.unsupported" ? 400 : code === "feedback.invalid_request" ? 400 : 502,
    code,
    retryable
  };
}
