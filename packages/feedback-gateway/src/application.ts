import type {
  FeedbackAppendRevisionCommandV2,
  FeedbackAttachmentCommandResultV2,
  FeedbackCapabilitiesV2,
  FeedbackCreateThreadCommandV2,
  FeedbackIntentRecoveryResultV2,
  FeedbackMessageCommandResultV2,
  FeedbackOperationV2,
  FeedbackProfileV2,
  FeedbackReplyCommandV2,
  FeedbackResourcePageV2,
  FeedbackResourceRefV2,
  FeedbackThreadCommandResultV2,
  FeedbackThreadPageV2,
  FeedbackThreadV2,
  FeedbackUploadAttachmentCommandV2,
  FeedbackWorkspacePageV2
} from "@geibee/feedback-contracts/v2";
import type { FeedbackProviderProfileV2 } from "@geibee/feedback-contracts/v2/server";
import type {
  FeedbackAbortSignal,
  FeedbackDownloadStream,
  FeedbackIntentRecoveryResultFor,
  FeedbackRepositoryOptions,
  FeedbackRepositoryPort,
  FeedbackRepositoryScope,
  FeedbackUploadStreamSource
} from "@geibee/feedback-connector-sdk";
import {
  intersectFeedbackOperations,
  selectFeedbackAuthorizationPort,
  type FeedbackAuthorizationDecision,
  type FeedbackAuthorizationGrant,
  type FeedbackAuthorizationRequest,
  type FeedbackAuthorizationTarget,
  type FeedbackGatewayComposition
} from "./index.js";

export type FeedbackGatewayProblemCode =
  | "feedback.invalid_request"
  | "feedback.unauthorized"
  | "feedback.forbidden"
  | "feedback.not_found"
  | "feedback.conflict"
  | "feedback.cursor_invalid"
  | "feedback.integrity_error"
  | "feedback.provider_unavailable"
  | "feedback.provider_timeout"
  | "feedback.authorization_unavailable"
  | "feedback.rate_limited"
  | "feedback.payload_too_large"
  | "feedback.unsupported_media_type"
  | "feedback.unsupported";

export class FeedbackGatewayProblem extends Error {
  readonly code: FeedbackGatewayProblemCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(input: {
    code: FeedbackGatewayProblemCode;
    status: number;
    message: string;
    retryable?: boolean;
    retryAfterSeconds?: number;
  }) {
    super(input.message);
    this.name = "FeedbackGatewayProblem";
    this.code = input.code;
    this.status = input.status;
    this.retryable = input.retryable ?? false;
    this.retryAfterSeconds = input.retryAfterSeconds;
  }
}

export type FeedbackGatewayAccess = {
  grant: FeedbackAuthorizationGrant;
  signal?: FeedbackAbortSignal;
};

type ResolvedAccess = {
  profile: FeedbackProviderProfileV2;
  repository: FeedbackRepositoryPort;
  capabilities: FeedbackCapabilitiesV2;
  authorization: FeedbackAuthorizationDecision;
  effectivePermissions: readonly FeedbackOperationV2[];
};

export type FeedbackGatewayRepositoryResolution = {
  profile: FeedbackProviderProfileV2;
  authorization: FeedbackAuthorizationDecision;
  access: FeedbackGatewayAccess;
};

/**
 * production compositionが認可済みrequest participantへConnectorを束縛するための実装port。
 * Authorization Modeの検証より前には呼ばれない。
 */
export type FeedbackGatewayRepositoryResolver = (
  input: FeedbackGatewayRepositoryResolution
) => Promise<FeedbackRepositoryPort> | FeedbackRepositoryPort;

export type FeedbackGatewayRuntimeComposition = FeedbackGatewayComposition & {
  readonly repositoryResolver?: FeedbackGatewayRepositoryResolver;
};

type ResourceInput = {
  profileId: string;
  workspaceId: string;
  resource: FeedbackResourceRefV2;
};

const allOperations: readonly FeedbackOperationV2[] = [
  "feedback:read",
  "feedback:create",
  "feedback:reply",
  "feedback:revise",
  "feedback:attachment:read",
  "feedback:attachment:upload"
];

function sameResource(left: FeedbackResourceRefV2, right: FeedbackResourceRefV2): boolean {
  return left.kind === right.kind && left.key === right.key;
}

function sameTarget(left: FeedbackAuthorizationTarget, right: FeedbackAuthorizationTarget): boolean {
  if (left.level !== right.level || left.profileId !== right.profileId) return false;
  if (left.level === "profile" && right.level === "profile") return true;
  if (left.level === "workspace" && right.level === "workspace") {
    return left.workspaceId === right.workspaceId;
  }
  if (left.level === "resource" && right.level === "resource") {
    return left.workspaceId === right.workspaceId && sameResource(left.resource, right.resource);
  }
  return false;
}

function repositoryScope(profile: FeedbackProviderProfileV2, input: ResourceInput): FeedbackRepositoryScope {
  return {
    profileId: profile.profileId,
    installationId: profile.installationId,
    workspaceId: input.workspaceId,
    resource: input.resource
  };
}

function repositoryOptions(signal?: FeedbackAbortSignal): FeedbackRepositoryOptions | undefined {
  return signal ? { signal } : undefined;
}

function summaryOf(thread: FeedbackThreadV2): FeedbackThreadPageV2["items"][number] {
  const { messages: _messages, ...summary } = thread;
  return summary;
}

function weakerGuarantee(
  configured: "recoverable" | "best-effort" | "unsupported",
  backend: "recoverable" | "best-effort" | "unsupported"
): "recoverable" | "best-effort" | "unsupported" {
  const strength = { unsupported: 0, "best-effort": 1, recoverable: 2 } as const;
  return strength[configured] <= strength[backend] ? configured : backend;
}

export class FeedbackGatewayApplicationService {
  readonly #composition: FeedbackGatewayRuntimeComposition;

  constructor(composition: FeedbackGatewayRuntimeComposition) {
    this.#composition = composition;
  }

  async #profile(profileId: string): Promise<FeedbackProviderProfileV2> {
    const profiles = await this.#composition.profileLoader.loadProfiles();
    const profile = profiles.find((candidate) => candidate.profileId === profileId);
    if (!profile) {
      throw new FeedbackGatewayProblem({
        code: "feedback.not_found",
        status: 404,
        message: "provider profileが見つかりません"
      });
    }
    return profile;
  }

  async #repository(
    profile: FeedbackProviderProfileV2,
    authorization: FeedbackAuthorizationDecision,
    access: FeedbackGatewayAccess
  ): Promise<FeedbackRepositoryPort> {
    if (this.#composition.repositoryResolver) {
      try {
        return await this.#composition.repositoryResolver({ profile, authorization, access });
      } catch (error) {
        if (error instanceof FeedbackGatewayProblem) throw error;
        throw new FeedbackGatewayProblem({
          code: "feedback.provider_unavailable",
          status: 502,
          retryable: true,
          message: "profileに対応するrequest-scoped Connectorを生成できません"
        });
      }
    }
    const repository = this.#composition.connectors.get(profile.connectorKey);
    if (!repository) {
      throw new FeedbackGatewayProblem({
        code: "feedback.provider_unavailable",
        status: 502,
        retryable: true,
        message: "profileに対応するConnectorがありません"
      });
    }
    return repository;
  }

  #validateWorkspace(profile: FeedbackProviderProfileV2, workspaceId: string): void {
    if (!profile.workspacePolicy.workspaceIds.includes(workspaceId)) {
      throw new FeedbackGatewayProblem({
        code: "feedback.not_found",
        status: 404,
        message: "workspaceがprofile scope外です"
      });
    }
  }

  #validateResource(profile: FeedbackProviderProfileV2, resource: FeedbackResourceRefV2): void {
    if (!profile.policy.resourceKinds.includes(resource.kind)) {
      throw new FeedbackGatewayProblem({
        code: "feedback.not_found",
        status: 404,
        message: "resource kindがprofile scope外です"
      });
    }
  }

  async #authorize(input: {
    profileId: string;
    target: FeedbackAuthorizationTarget;
    requiredOperations: readonly FeedbackOperationV2[];
    requestedOperations?: readonly FeedbackOperationV2[];
    access: FeedbackGatewayAccess;
  }): Promise<ResolvedAccess> {
    const profile = await this.#profile(input.profileId);
    if (input.target.profileId !== profile.profileId) {
      throw new FeedbackGatewayProblem({ code: "feedback.forbidden", status: 403, message: "profile scopeが一致しません" });
    }
    if (input.target.level !== "profile") {
      this.#validateWorkspace(profile, input.target.workspaceId);
    }
    if (input.target.level === "resource") {
      this.#validateResource(profile, input.target.resource);
    }
    if (input.access.grant.mode !== profile.authorization.mode) {
      throw new FeedbackGatewayProblem({
        code: "feedback.unauthorized",
        status: 401,
        message: "profile固定Authorization Modeとcredentialが一致しません"
      });
    }

    const port = selectFeedbackAuthorizationPort(profile, this.#composition.authorizationPorts);
    const request: FeedbackAuthorizationRequest = {
      target: input.target,
      requestedOperations: input.requestedOperations ?? input.requiredOperations,
      grant: input.access.grant
    };
    let authorization: FeedbackAuthorizationDecision;
    try {
      authorization = await port.authorize(request, input.access.signal);
    } catch (error) {
      if (error instanceof FeedbackGatewayProblem) throw error;
      throw new FeedbackGatewayProblem({
        code: profile.authorization.mode === "remote-authorization"
          ? "feedback.authorization_unavailable"
          : "feedback.unauthorized",
        status: profile.authorization.mode === "remote-authorization" ? 503 : 401,
        message: "Authorization Modeによる検証に失敗しました"
      });
    }
    if (authorization.mode !== profile.authorization.mode || !sameTarget(authorization.target, input.target)) {
      throw new FeedbackGatewayProblem({
        code: "feedback.forbidden",
        status: 403,
        message: "認可decisionの対象またはmodeが一致しません"
      });
    }

    // capability照会では、候補operationを実行要求と誤認させない。
    const repository = await this.#repository(profile, input.requestedOperations
      ? { ...authorization, allowedOperations: input.requiredOperations } : authorization, input.access);
    const capabilities = await repository.getCapabilities(repositoryOptions(input.access.signal));
    const configuredBackend = intersectFeedbackOperations(
      profile.capabilities.operations,
      capabilities.backendOperations,
      capabilities.backendOperations
    );
    const effectivePermissions = intersectFeedbackOperations(
      authorization.allowedOperations,
      profile.policy.operations,
      configuredBackend
    );
    for (const operation of input.requiredOperations) {
      if (!effectivePermissions.includes(operation)) {
        throw new FeedbackGatewayProblem({
          code: "feedback.forbidden",
          status: 403,
          message: `operationは許可されていません: ${operation}`
        });
      }
    }
    return { profile, repository, capabilities, authorization, effectivePermissions };
  }

  async getProfile(input: ResourceInput & { access: FeedbackGatewayAccess }): Promise<FeedbackProfileV2> {
    const profile = await this.#profile(input.profileId);
    // profileは操作の実行ではなく許可集合の照会。拒否された任意操作を必須にしない。
    const candidates = input.access.grant.mode === "signed-grant"
      ? input.access.grant.allowedOperations : profile.policy.operations;
    const requestedOperations = [...new Set<FeedbackOperationV2>(["feedback:read", ...candidates.filter(
      (operation) => profile.policy.operations.includes(operation) && profile.capabilities.operations.includes(operation)
    )])];
    const target: FeedbackAuthorizationTarget = { level: "resource", ...input, resource: input.resource };
    const resolved = await this.#authorize({
      profileId: input.profileId,
      target,
      requiredOperations: ["feedback:read"],
      requestedOperations,
      access: input.access
    });
    return {
      schemaVersion: "2",
      profileId: resolved.profile.profileId,
      displayName: resolved.profile.displayName,
      capabilities: {
        ...resolved.capabilities,
        backendOperations: [...intersectFeedbackOperations(
          resolved.profile.capabilities.operations,
          resolved.capabilities.backendOperations,
          resolved.capabilities.backendOperations
        )],
        discovery: {
          workspaces: resolved.profile.capabilities.discovery.workspaces === "supported" &&
            resolved.capabilities.discovery.workspaces === "supported" ? "supported" : "unsupported",
          resources: resolved.profile.capabilities.discovery.resources === "supported" &&
            resolved.capabilities.discovery.resources === "supported" ? "supported" : "unsupported"
        },
        operationGuarantees: {
          create: weakerGuarantee(resolved.profile.capabilities.operationGuarantees.create, resolved.capabilities.operationGuarantees.create),
          reply: weakerGuarantee(resolved.profile.capabilities.operationGuarantees.reply, resolved.capabilities.operationGuarantees.reply),
          revision: weakerGuarantee(resolved.profile.capabilities.operationGuarantees.revision, resolved.capabilities.operationGuarantees.revision),
          attachmentUpload: weakerGuarantee(
            resolved.profile.capabilities.operationGuarantees.attachmentUpload,
            resolved.capabilities.operationGuarantees.attachmentUpload
          )
        },
        creationFields: resolved.capabilities.creationFields.filter((field) =>
          resolved.profile.capabilities.creationFields.some((configured) => configured.key === field.key)
        )
      },
      effectivePermissions: [...resolved.effectivePermissions]
    };
  }

  async listWorkspaces(input: {
    profileId: string;
    cursor?: string;
    access: FeedbackGatewayAccess;
  }): Promise<FeedbackWorkspacePageV2> {
    const resolved = await this.#authorize({
      profileId: input.profileId,
      target: { level: "profile", profileId: input.profileId },
      requiredOperations: ["feedback:read"],
      access: input.access
    });
    if (resolved.profile.workspacePolicy.workspaceDiscovery !== "supported" ||
        resolved.capabilities.discovery.workspaces !== "supported") {
      throw new FeedbackGatewayProblem({ code: "feedback.unsupported", status: 422, message: "workspace discoveryは未対応です" });
    }
    const page = await resolved.repository.listWorkspaces(
      input.profileId,
      input.cursor,
      repositoryOptions(input.access.signal)
    );
    return {
      ...page,
      items: page.items.filter((item) =>
        resolved.profile.workspacePolicy.workspaceIds.includes(item.workspaceId) &&
        (input.access.grant.mode !== "signed-grant" || item.workspaceId === input.access.grant.boundTarget.workspaceId)
      )
    };
  }

  async listResources(input: {
    profileId: string;
    workspaceId: string;
    query?: string;
    cursor?: string;
    access: FeedbackGatewayAccess;
  }): Promise<FeedbackResourcePageV2> {
    const resolved = await this.#authorize({
      profileId: input.profileId,
      target: { level: "workspace", profileId: input.profileId, workspaceId: input.workspaceId },
      requiredOperations: ["feedback:read"],
      access: input.access
    });
    if (resolved.profile.workspacePolicy.resourceDiscovery !== "supported" ||
        resolved.capabilities.discovery.resources !== "supported") {
      throw new FeedbackGatewayProblem({ code: "feedback.unsupported", status: 422, message: "resource discoveryは未対応です" });
    }
    const page = await resolved.repository.listResources({
      profileId: input.profileId,
      workspaceId: input.workspaceId,
      query: input.query,
      cursor: input.cursor
    }, repositoryOptions(input.access.signal));
    return {
      ...page,
      items: page.items.filter((item) =>
        resolved.profile.policy.resourceKinds.includes(item.resource.kind) &&
        (input.access.grant.mode !== "signed-grant" || sameResource(item.resource, input.access.grant.boundTarget.resource))
      )
    };
  }

  async listThreads(input: ResourceInput & {
    order?: "updated_desc" | "updated_asc";
    cursor?: string;
    access: FeedbackGatewayAccess;
  }): Promise<FeedbackThreadPageV2> {
    const target: FeedbackAuthorizationTarget = { level: "resource", profileId: input.profileId, workspaceId: input.workspaceId, resource: input.resource };
    const resolved = await this.#authorize({ profileId: input.profileId, target, requiredOperations: ["feedback:read"], access: input.access });
    const page = await resolved.repository.findThreadCandidates({
      ...repositoryScope(resolved.profile, input),
      order: input.order,
      cursor: input.cursor
    }, repositoryOptions(input.access.signal));
    const items: FeedbackThreadPageV2["items"] = [];
    for (const candidate of page.candidates) {
      const read = await resolved.repository.readCandidate(candidate, repositoryOptions(input.access.signal));
      const verification = await this.#composition.projectionVerifier.verify(candidate, read, {
        profileId: input.profileId,
        workspaceId: input.workspaceId,
        resource: input.resource,
        authorization: resolved.authorization,
        profile: resolved.profile
      });
      if (verification.valid) items.push(summaryOf(verification.record.thread));
    }
    return { items, nextCursor: page.nextCursor };
  }

  async getThread(input: ResourceInput & { threadId: string; access: FeedbackGatewayAccess }): Promise<FeedbackThreadV2> {
    const target: FeedbackAuthorizationTarget = { level: "resource", profileId: input.profileId, workspaceId: input.workspaceId, resource: input.resource };
    const resolved = await this.#authorize({ profileId: input.profileId, target, requiredOperations: ["feedback:read"], access: input.access });
    const scope = repositoryScope(resolved.profile, input);
    const candidates = await resolved.repository.findThreadCandidatesById(
      { ...scope, threadId: input.threadId },
      repositoryOptions(input.access.signal)
    );
    if (candidates.length === 0) {
      throw new FeedbackGatewayProblem({ code: "feedback.not_found", status: 404, message: "threadが見つかりません" });
    }
    if (candidates.length !== 1) {
      throw new FeedbackGatewayProblem({ code: "feedback.conflict", status: 409, message: "threadIdに複数候補があります" });
    }
    const candidate = candidates[0]!;
    const read = await resolved.repository.readCandidate(candidate, repositoryOptions(input.access.signal));
    const verification = await this.#composition.projectionVerifier.verify(candidate, read, {
      profileId: input.profileId,
      workspaceId: input.workspaceId,
      resource: input.resource,
      authorization: resolved.authorization,
      profile: resolved.profile
    });
    if (!verification.valid || verification.record.thread.threadId !== input.threadId) {
      throw new FeedbackGatewayProblem({
        code: "feedback.integrity_error",
        status: 409,
        message: `thread候補の検証に失敗しました: ${verification.valid ? "binding" : verification.reason}`
      });
    }
    return verification.record.thread;
  }

  async createThread(input: ResourceInput & { command: FeedbackCreateThreadCommandV2; access: FeedbackGatewayAccess }): Promise<FeedbackThreadCommandResultV2 | FeedbackIntentRecoveryResultFor<"feedback:create">> {
    if (!sameResource(input.resource, input.command.resource)) {
      throw new FeedbackGatewayProblem({ code: "feedback.invalid_request", status: 400, message: "command resourceとrequest scopeが一致しません" });
    }
    const target: FeedbackAuthorizationTarget = { level: "resource", profileId: input.profileId, workspaceId: input.workspaceId, resource: input.resource };
    const resolved = await this.#authorize({ profileId: input.profileId, target, requiredOperations: ["feedback:create"], access: input.access });
    return resolved.repository.createThread({ ...repositoryScope(resolved.profile, input), command: input.command }, repositoryOptions(input.access.signal));
  }

  async reply(input: ResourceInput & { threadId: string; command: FeedbackReplyCommandV2; access: FeedbackGatewayAccess }): Promise<FeedbackMessageCommandResultV2 | FeedbackIntentRecoveryResultFor<"feedback:reply">> {
    const target: FeedbackAuthorizationTarget = { level: "resource", profileId: input.profileId, workspaceId: input.workspaceId, resource: input.resource };
    const resolved = await this.#authorize({ profileId: input.profileId, target, requiredOperations: ["feedback:reply"], access: input.access });
    return resolved.repository.reply({ ...repositoryScope(resolved.profile, input), threadId: input.threadId, command: input.command }, repositoryOptions(input.access.signal));
  }

  async appendRevision(input: ResourceInput & { threadId: string; messageId: string; command: FeedbackAppendRevisionCommandV2; access: FeedbackGatewayAccess }): Promise<FeedbackMessageCommandResultV2 | FeedbackIntentRecoveryResultFor<"feedback:revise">> {
    const target: FeedbackAuthorizationTarget = { level: "resource", profileId: input.profileId, workspaceId: input.workspaceId, resource: input.resource };
    const resolved = await this.#authorize({ profileId: input.profileId, target, requiredOperations: ["feedback:revise"], access: input.access });
    return resolved.repository.appendRevision({ ...repositoryScope(resolved.profile, input), threadId: input.threadId, messageId: input.messageId, command: input.command }, repositoryOptions(input.access.signal));
  }

  async recoverIntent(input: ResourceInput & {
    threadId: string;
    intentId: string;
    requestHash: string;
    operation: FeedbackOperationV2;
    access: FeedbackGatewayAccess;
  }): Promise<FeedbackIntentRecoveryResultV2> {
    if (!allOperations.includes(input.operation) || input.operation === "feedback:read" || input.operation === "feedback:attachment:read") {
      throw new FeedbackGatewayProblem({ code: "feedback.invalid_request", status: 400, message: "回収対象operationが不正です" });
    }
    const target: FeedbackAuthorizationTarget = { level: "resource", profileId: input.profileId, workspaceId: input.workspaceId, resource: input.resource };
    const resolved = await this.#authorize({ profileId: input.profileId, target, requiredOperations: [input.operation], access: input.access });
    return resolved.repository.recoverIntent({
      ...repositoryScope(resolved.profile, input),
      threadId: input.threadId,
      intentId: input.intentId,
      requestHash: input.requestHash,
      operation: input.operation
    }, repositoryOptions(input.access.signal));
  }

  async uploadAttachment(input: ResourceInput & {
    threadId: string;
    command: FeedbackUploadAttachmentCommandV2;
    source: FeedbackUploadStreamSource;
    access: FeedbackGatewayAccess;
  }): Promise<FeedbackAttachmentCommandResultV2 | FeedbackIntentRecoveryResultFor<"feedback:attachment:upload">> {
    const target: FeedbackAuthorizationTarget = { level: "resource", profileId: input.profileId, workspaceId: input.workspaceId, resource: input.resource };
    const resolved = await this.#authorize({ profileId: input.profileId, target, requiredOperations: ["feedback:attachment:upload"], access: input.access });
    if (input.source.sizeBytes !== input.command.sizeBytes || input.command.sizeBytes > resolved.capabilities.maximumAttachmentBytes) {
      throw new FeedbackGatewayProblem({ code: "feedback.payload_too_large", status: 413, message: "attachment sizeが許可範囲外です" });
    }
    if (!resolved.capabilities.attachmentContentTypes.includes(input.command.contentType)) {
      throw new FeedbackGatewayProblem({ code: "feedback.unsupported_media_type", status: 415, message: "attachment content typeは未対応です" });
    }
    return resolved.repository.uploadAttachment({ ...repositoryScope(resolved.profile, input), threadId: input.threadId, command: input.command, source: input.source }, repositoryOptions(input.access.signal));
  }

  async getAttachment(input: ResourceInput & { threadId: string; attachmentId: string; access: FeedbackGatewayAccess }): Promise<FeedbackDownloadStream> {
    const target: FeedbackAuthorizationTarget = { level: "resource", profileId: input.profileId, workspaceId: input.workspaceId, resource: input.resource };
    const resolved = await this.#authorize({ profileId: input.profileId, target, requiredOperations: ["feedback:attachment:read"], access: input.access });
    return resolved.repository.getAttachment({ ...repositoryScope(resolved.profile, input), threadId: input.threadId, attachmentId: input.attachmentId }, repositoryOptions(input.access.signal));
  }

  async authorizeLegacyV1(input: {
    profileId: string;
    workspaceId: string;
    resource: FeedbackResourceRefV2;
    operation: FeedbackOperationV2;
    access: FeedbackGatewayAccess;
  }): Promise<FeedbackAuthorizationDecision> {
    const target: FeedbackAuthorizationTarget = { level: "resource", profileId: input.profileId, workspaceId: input.workspaceId, resource: input.resource };
    const resolved = await this.#authorize({ profileId: input.profileId, target, requiredOperations: [input.operation], access: input.access });
    return resolved.authorization;
  }
}
