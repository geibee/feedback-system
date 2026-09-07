/* このファイルはfeedback-provider-profile.schema.jsonから生成されます。手編集しないでください。 */

export type StableKey = string;
export type AuthorizationConfiguration = PublicAuthorization | SignedGrantAuthorization | RemoteAuthorization;
export type Operation =
  | "feedback:read"
  | "feedback:create"
  | "feedback:reply"
  | "feedback:revise"
  | "feedback:attachment:read"
  | "feedback:attachment:upload";
export type OperationGuarantee = "recoverable" | "best-effort" | "unsupported";

/**
 * 起動時に一つのAuthorization Modeへ固定するread-only provider profile
 */
export interface FeedbackProviderProfileV2 {
  schemaVersion: "2";
  profileId: StableKey;
  displayName: string;
  connectorKey: StableKey;
  installationId: string;
  connectorProfileRef?: StableKey;
  workspacePolicy: WorkspacePolicy;
  authorization: AuthorizationConfiguration;
  policy: ProfilePolicy;
  capabilities: BackendCapabilities;
  secretRefs: SecretReferences;
}
export interface WorkspacePolicy {
  /**
   * @minItems 1
   * @maxItems 100
   */
  workspaceIds: [StableKey, ...StableKey[]];
  workspaceDiscovery: "supported" | "unsupported";
  resourceDiscovery: "supported" | "unsupported";
}
export interface PublicAuthorization {
  mode: "public-profile";
}
export interface SignedGrantAuthorization {
  mode: "signed-grant";
  issuerProfileRef: StableKey;
}
export interface RemoteAuthorization {
  mode: "remote-authorization";
  authorizationProfileRef: StableKey;
  subjectSource: "authenticated-adapter";
}
export interface ProfilePolicy {
  operations: Operation[];
  /**
   * @minItems 1
   */
  resourceKinds: [StableKey, ...StableKey[]];
}
export interface BackendCapabilities {
  operations: Operation[];
  discovery: {
    workspaces: "supported" | "unsupported";
    resources: "supported" | "unsupported";
  };
  operationGuarantees: {
    create: OperationGuarantee;
    reply: OperationGuarantee;
    revision: OperationGuarantee;
    attachmentUpload: OperationGuarantee;
  };
  /**
   * @maxItems 50
   */
  creationFields: CreationField[];
  maximumMetadataBytes: number;
  projectionValidation: "envelope-required";
  /**
   * trueはprovider検索の一意解決能力の申告。falseは重複排除best-effort。いずれもexactly-onceを保証せず、可視の複数候補を拒否する。
   */
  uniqueThreadLookup: boolean;
}
export interface CreationField {
  key: StableKey;
  label: string;
  type: "text" | "date" | "select" | "reference";
  required: boolean;
  /**
   * @maxItems 500
   */
  options?: {
    value: string;
    label: string;
  }[];
}
export interface SecretReferences {
  providerCredential: SecretReference;
  envelopeKeyRing: SecretReference;
  participantCredentialKeyRing: SecretReference;
  participantIdDerivationKey: SecretReference;
  threadReferenceKeyRing?: SecretReference;
  authorizationCredential?: SecretReference;
}
export interface SecretReference {
  kind: "server-secret";
  id: string;
}
