import type {
  FeedbackOperationV2,
  FeedbackResourceRefV2,
} from "@geibee/feedback-contracts/v2";
import type {
  FeedbackProviderProfileV2,
  RemoteAuthorizationDecisionV2,
  RemoteAuthorizationRequestV2
} from "@geibee/feedback-contracts/v2/server";
import type {
  FeedbackAbortSignal,
  FeedbackProjectionCandidate,
  FeedbackRepositoryPort,
  FeedbackRepositoryCandidateRead,
  FeedbackRepositoryRecord
} from "@geibee/feedback-connector-sdk";

export const feedbackAuthorizationModes = [
  "public-profile",
  "signed-grant",
  "remote-authorization"
] as const;

export type FeedbackAuthorizationMode = typeof feedbackAuthorizationModes[number];

export type FeedbackAuthorizationScope = {
  profileId: string;
  workspaceId: string;
  resource: FeedbackResourceRefV2;
};

export type FeedbackAuthorizationTarget =
  | { level: "profile"; profileId: string }
  | { level: "workspace"; profileId: string; workspaceId: string }
  | { level: "resource"; profileId: string; workspaceId: string; resource: FeedbackResourceRefV2 };

export type FeedbackAuthorizationGrant =
  | {
      mode: "public-profile";
      source: "profile-reachability";
    }
  | {
      mode: "signed-grant";
      source: "verified-jwt";
      subjectId: string;
      allowedOperations: readonly FeedbackOperationV2[];
      boundTarget: Extract<FeedbackAuthorizationTarget, { level: "resource" }>;
    }
  | {
      mode: "remote-authorization";
      source: "authenticated-adapter";
      subjectId: string;
      remoteRequest: RemoteAuthorizationRequestV2;
    };

export type FeedbackAuthorizationRequest = {
  target: FeedbackAuthorizationTarget;
  requestedOperations: readonly FeedbackOperationV2[];
  grant: FeedbackAuthorizationGrant;
};

export type FeedbackAuthorizationDecision = {
  target: FeedbackAuthorizationTarget;
  mode: FeedbackAuthorizationMode;
  subjectId?: string;
  allowedOperations: readonly FeedbackOperationV2[];
  remoteDecision?: RemoteAuthorizationDecisionV2;
};

export interface FeedbackAuthorizationPort {
  readonly mode: FeedbackAuthorizationMode;
  authorize(request: FeedbackAuthorizationRequest, signal?: FeedbackAbortSignal): Promise<FeedbackAuthorizationDecision>;
}

export interface RecordingFeedbackAuthorizationPort extends FeedbackAuthorizationPort {
  readonly calls: readonly FeedbackAuthorizationRequest[];
}

export function createFakeFeedbackAuthorizationPort(
  mode: FeedbackAuthorizationMode,
  authorize: FeedbackAuthorizationPort["authorize"]
): RecordingFeedbackAuthorizationPort {
  const calls: FeedbackAuthorizationRequest[] = [];
  return Object.freeze({
    mode,
    get calls() { return calls; },
    async authorize(request: FeedbackAuthorizationRequest, signal?: FeedbackAbortSignal) {
      calls.push(request);
      return authorize(request, signal);
    }
  });
}

export function selectFeedbackAuthorizationPort(
  profile: FeedbackProviderProfileV2,
  ports: ReadonlyMap<FeedbackAuthorizationMode, FeedbackAuthorizationPort>
): FeedbackAuthorizationPort {
  const configuredMode = profile.authorization.mode;
  const port = ports.get(configuredMode);
  if (!port || port.mode !== configuredMode) {
    throw new Error(`profile固定Authorization Modeのportがありません: ${profile.profileId}:${configuredMode}`);
  }
  return port;
}

export function intersectFeedbackOperations(
  authorized: readonly FeedbackOperationV2[],
  policy: readonly FeedbackOperationV2[],
  backend: readonly FeedbackOperationV2[]
): readonly FeedbackOperationV2[] {
  const policySet = new Set(policy);
  const backendSet = new Set(backend);
  return [...new Set(authorized)].filter((operation) => policySet.has(operation) && backendSet.has(operation));
}

export interface FeedbackProfileLoaderPort {
  loadProfiles(): Promise<readonly FeedbackProviderProfileV2[]>;
}

export type FeedbackProjectionVerificationContext = FeedbackAuthorizationScope & {
  authorization: FeedbackAuthorizationDecision;
  profile: FeedbackProviderProfileV2;
};

export type FeedbackProjectionVerification =
  | { valid: true; record: FeedbackRepositoryRecord }
  | { valid: false; reason: "schema" | "signature" | "binding" | "scope" | "authorization" | "policy" | "capability" };

export interface FeedbackProjectionVerifierPort {
  verify(
    candidate: FeedbackProjectionCandidate,
    record: FeedbackRepositoryCandidateRead,
    context: FeedbackProjectionVerificationContext
  ): Promise<FeedbackProjectionVerification>;
}

export type FeedbackConnectorRegistration = {
  connectorKey: string;
  repository: FeedbackRepositoryPort;
};

export interface FeedbackGatewayComposition {
  readonly profileLoader: FeedbackProfileLoaderPort;
  readonly authorizationPorts: ReadonlyMap<FeedbackAuthorizationMode, FeedbackAuthorizationPort>;
  readonly connectors: ReadonlyMap<string, FeedbackRepositoryPort>;
  readonly projectionVerifier: FeedbackProjectionVerifierPort;
}

export * from "./application.js";
