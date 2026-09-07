import type { FeedbackOperationV2, FeedbackResourceRefV2 } from "@geibee/feedback-contracts/v2";
import type { FeedbackAbortSignal } from "@geibee/feedback-connector-sdk";
import {
  FeedbackGatewayApplicationService,
  type FeedbackAuthorizationDecision,
  type FeedbackAuthorizationTarget
} from "@geibee/feedback-gateway";
import type { FeedbackAuthorizationRuntime } from "./authorization.js";

/**
 * v1 DTO変換の前段で、v2と同じprofile固定Authorization Modeを強制するguard。
 * legacy pathだけをpublic-profileとしてmountする実装を作らないための境界です。
 */
export function createFeedbackV1FacadeGuard(input: {
  gateway: FeedbackGatewayApplicationService;
  authorization: FeedbackAuthorizationRuntime;
}) {
  return async (request: {
    profileId: string;
    workspaceId: string;
    resource: FeedbackResourceRefV2;
    operation: FeedbackOperationV2;
    bearerToken?: string;
    authenticatedSubjectId?: string;
    signal?: FeedbackAbortSignal;
  }): Promise<FeedbackAuthorizationDecision> => {
    const target: FeedbackAuthorizationTarget = {
      level: "resource",
      profileId: request.profileId,
      workspaceId: request.workspaceId,
      resource: request.resource
    };
    const access = await input.authorization.createAccess({
      profileId: request.profileId,
      target,
      requestedOperations: [request.operation],
      bearerToken: request.bearerToken,
      authenticatedSubjectId: request.authenticatedSubjectId,
      signal: request.signal
    });
    return input.gateway.authorizeLegacyV1({
      profileId: request.profileId,
      workspaceId: request.workspaceId,
      resource: request.resource,
      operation: request.operation,
      access
    });
  };
}
