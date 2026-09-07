import type { FeedbackCapabilitiesV2, FeedbackOperationGuaranteeV2 } from "@geibee/feedback-contracts/v2";
import type {
  FeedbackRepositoryOptions,
  FeedbackRepositoryPort
} from "./index.js";

export type FeedbackRepositoryMethod = keyof FeedbackRepositoryPort;

export type FeedbackRepositoryCall = {
  method: FeedbackRepositoryMethod;
  query: unknown;
  options: FeedbackRepositoryOptions | undefined;
};

export interface RecordingFeedbackRepository extends FeedbackRepositoryPort {
  readonly calls: readonly FeedbackRepositoryCall[];
  count(method: FeedbackRepositoryMethod): number;
}

export function createFakeFeedbackRepository(
  handlers: Partial<FeedbackRepositoryPort> = {}
): RecordingFeedbackRepository {
  const calls: FeedbackRepositoryCall[] = [];
  const missing = (method: FeedbackRepositoryMethod): never => {
    throw new Error(`unexpected FeedbackRepositoryPort call: ${method}`);
  };
  const record = (method: FeedbackRepositoryMethod, query: unknown, options: FeedbackRepositoryOptions | undefined) => {
    calls.push({ method, query, options });
  };
  return {
    ...(handlers.supportsThreadReferences ? { supportsThreadReferences: true as const } : {}),
    get calls() { return calls; },
    count: (method) => calls.filter((call) => call.method === method).length,
    async getCapabilities(options) {
      record("getCapabilities", undefined, options);
      return handlers.getCapabilities ? handlers.getCapabilities(options) : missing("getCapabilities");
    },
    async listWorkspaces(profileId, cursor, options) {
      record("listWorkspaces", { profileId, cursor }, options);
      return handlers.listWorkspaces ? handlers.listWorkspaces(profileId, cursor, options) : missing("listWorkspaces");
    },
    async listResources(query, options) {
      record("listResources", query, options);
      return handlers.listResources ? handlers.listResources(query, options) : missing("listResources");
    },
    async findThreadCandidates(query, options) {
      record("findThreadCandidates", query, options);
      return handlers.findThreadCandidates ? handlers.findThreadCandidates(query, options) : missing("findThreadCandidates");
    },
    async findThreadCandidatesById(query, options) {
      record("findThreadCandidatesById", query, options);
      return handlers.findThreadCandidatesById ? handlers.findThreadCandidatesById(query, options) : missing("findThreadCandidatesById");
    },
    async readCandidate(query, options) {
      record("readCandidate", query, options);
      return handlers.readCandidate ? handlers.readCandidate(query, options) : missing("readCandidate");
    },
    async createThread(query, options) {
      record("createThread", query, options);
      return handlers.createThread ? handlers.createThread(query, options) : missing("createThread");
    },
    async reply(query, options) {
      record("reply", query, options);
      return handlers.reply ? handlers.reply(query, options) : missing("reply");
    },
    async appendRevision(query, options) {
      record("appendRevision", query, options);
      return handlers.appendRevision ? handlers.appendRevision(query, options) : missing("appendRevision");
    },
    async recoverIntent(query, options) {
      record("recoverIntent", query, options);
      return handlers.recoverIntent ? handlers.recoverIntent(query, options) : missing("recoverIntent");
    },
    async uploadAttachment(query, options) {
      record("uploadAttachment", query, options);
      return handlers.uploadAttachment ? handlers.uploadAttachment(query, options) : missing("uploadAttachment");
    },
    async getAttachment(query, options) {
      record("getAttachment", query, options);
      return handlers.getAttachment ? handlers.getAttachment(query, options) : missing("getAttachment");
    }
  };
}

export type FeedbackProviderOperationFacts = {
  guarantee: FeedbackOperationGuaranteeV2;
  bodyAndIntentMarkerSingleWrite: boolean;
  providerBackedLookup: "unique" | "eventual" | "none";
};

export type FeedbackConnectorContractFixture = {
  schemaVersion: "feedback-connector-tck.v1";
  connectorKey: string;
  capabilities: FeedbackCapabilitiesV2;
  firstThreadWriteFields: readonly string[];
  uniqueThreadLookup: boolean;
  operations: {
    create: FeedbackProviderOperationFacts;
    reply: FeedbackProviderOperationFacts;
    revision: FeedbackProviderOperationFacts;
    attachmentUpload: FeedbackProviderOperationFacts & {
      automaticBinaryRetry: boolean;
      signedProviderMapping: boolean;
    };
  };
  searchMissDecision: "pending";
  multipleHitDecision: "repair_required";
};

export function assertFeedbackConnectorContractFixture(fixture: FeedbackConnectorContractFixture): void {
  if (fixture.schemaVersion !== "feedback-connector-tck.v1") {
    throw new Error(`${fixture.connectorKey}: TCK fixture versionが不正です`);
  }
  const requiredFirstWrite = ["threadId", "intentId", "requestHash"];
  for (const field of requiredFirstWrite) {
    if (!fixture.firstThreadWriteFields.includes(field)) {
      throw new Error(`${fixture.connectorKey}: 最初のthread writeに${field}がありません`);
    }
  }
  if (!fixture.uniqueThreadLookup || fixture.capabilities.operationGuarantees.create !== fixture.operations.create.guarantee) {
    throw new Error(`${fixture.connectorKey}: create回復capabilityとprovider事実が一致しません`);
  }
  for (const [name, facts] of Object.entries(fixture.operations)) {
    if (facts.guarantee === "recoverable" &&
      (!facts.bodyAndIntentMarkerSingleWrite || facts.providerBackedLookup === "none")) {
      throw new Error(`${fixture.connectorKey}: ${name}をrecoverableにできるprovider事実がありません`);
    }
  }
  if (fixture.operations.attachmentUpload.automaticBinaryRetry) {
    throw new Error(`${fixture.connectorKey}: attachment binaryの自動再送は禁止です`);
  }
  if (fixture.operations.attachmentUpload.guarantee === "recoverable" &&
    !fixture.operations.attachmentUpload.signedProviderMapping) {
    throw new Error(`${fixture.connectorKey}: attachment stable IDの署名済みprovider mappingがありません`);
  }
  if (fixture.searchMissDecision !== "pending" || fixture.multipleHitDecision !== "repair_required") {
    throw new Error(`${fixture.connectorKey}: eventual searchのfail-closed判定が不正です`);
  }
}
