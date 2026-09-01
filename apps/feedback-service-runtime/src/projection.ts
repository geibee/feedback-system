import type {
  FeedbackProjectionCandidate,
  FeedbackRepositoryCandidateRead
} from "@geibee/feedback-connector-sdk";
import type {
  FeedbackProjectionVerification,
  FeedbackProjectionVerificationContext,
  FeedbackProjectionVerifierPort
} from "@geibee/feedback-gateway";
import { FeedbackGatewayProblem } from "@geibee/feedback-gateway";
import type { FeedbackEnvelopeCodecPort } from "@geibee/feedback-envelope";
import type { FeedbackConnectorCatalog } from "./catalog.js";

export function createProductionFeedbackProjectionVerifier(input: {
  catalog: FeedbackConnectorCatalog;
  loadCodec(profileId: string): Promise<FeedbackEnvelopeCodecPort>;
}): FeedbackProjectionVerifierPort {
  return Object.freeze({
    async verify(
      candidate: FeedbackProjectionCandidate,
      record: FeedbackRepositoryCandidateRead,
      context: FeedbackProjectionVerificationContext
    ) {
      return verifyProjection(input, candidate, record, context);
    }
  });
}

async function verifyProjection(
  input: {
    catalog: FeedbackConnectorCatalog;
    loadCodec(profileId: string): Promise<FeedbackEnvelopeCodecPort>;
  },
  candidate: FeedbackProjectionCandidate,
  record: FeedbackRepositoryCandidateRead,
  context: FeedbackProjectionVerificationContext
): Promise<FeedbackProjectionVerification> {
  const runtimeRef = context.profile.connectorProfileRef;
  const runtime = runtimeRef ? input.catalog.profiles.get(runtimeRef) : undefined;
  if (!runtime || runtime.connectorKey !== context.profile.connectorKey) return { valid: false, reason: "binding" };
  if (!sameProviderRef(candidate.providerRef, record.providerRef) ||
      record.providerRef.providerKey !== context.profile.connectorKey) return { valid: false, reason: "binding" };
  if (!sameScope(candidate, context)) return { valid: false, reason: "scope" };
  if (!context.authorization.allowedOperations.includes("feedback:read")) return { valid: false, reason: "authorization" };
  if (!context.profile.policy.operations.includes("feedback:read")) return { valid: false, reason: "policy" };
  if (!context.profile.capabilities.operations.includes("feedback:read")) return { valid: false, reason: "capability" };

  let codec: FeedbackEnvelopeCodecPort;
  try {
    codec = await input.loadCodec(context.profile.profileId);
  } catch {
    throw new FeedbackGatewayProblem({
      code: "feedback.provider_unavailable",
      status: 502,
      retryable: true,
      message: "Envelope検証鍵を解決できません"
    });
  }
  let verification: Awaited<ReturnType<FeedbackEnvelopeCodecPort["verifyEnvelope"]>>;
  try {
    verification = await codec.verifyEnvelope(record.envelope, {
      profileId: context.profile.profileId,
      installationId: context.profile.installationId,
      objectId: record.providerRef.objectId
    });
  } catch {
    return { valid: false, reason: "signature" };
  }
  if (!verification.valid) {
    return { valid: false, reason: verification.reason === "binding" ? "binding" : verification.reason === "schema" ? "schema" : "signature" };
  }
  const envelope = verification.envelope;
  if (envelope.threadId !== candidate.projection.threadId ||
      envelope.intentId !== candidate.projection.intentId ||
      envelope.requestHash !== candidate.projection.requestHash ||
      envelope.scope.workspace !== context.workspaceId ||
      envelope.scope.application !== runtime.application ||
      envelope.scope.environment !== runtime.environment ||
      !sameResource(envelope.scope.resource, context.resource) ||
      !sameResource(record.thread.resource, context.resource) ||
      record.thread.threadId !== envelope.threadId) {
    return { valid: false, reason: "scope" };
  }
  return {
    valid: true,
    record: { providerRef: record.providerRef, envelope, thread: record.thread }
  };
}

function sameProviderRef(left: FeedbackProjectionCandidate["providerRef"], right: FeedbackProjectionCandidate["providerRef"]): boolean {
  return left.providerKey === right.providerKey && left.objectId === right.objectId;
}

function sameScope(candidate: FeedbackProjectionCandidate, context: FeedbackProjectionVerificationContext): boolean {
  return candidate.projection.profileId === context.profileId &&
    candidate.projection.workspaceId === context.workspaceId &&
    sameResource(candidate.projection.resource, context.resource);
}

function sameResource(left: { kind: string; key: string }, right: { kind: string; key: string }): boolean {
  return left.kind === right.kind && left.key === right.key;
}
