/* このファイルはfeedback-envelope.schema.jsonから生成されます。手編集しないでください。 */

export type StableId = string;
export type RequestHash = string;
export type StableKey = string;
export type Scalar = string | number | boolean | null;

/**
 * ticket管理systemへ保存する署名付きFeedback thread Envelope
 */
export interface FeedbackEnvelopeV2 {
  schemaVersion: "2";
  threadId: StableId;
  intentId: StableId;
  requestHash: RequestHash;
  providerBinding: ProviderBinding;
  scope: StoredScope;
  createdBy: CreatedBy;
  createdAt: string;
  release?: string;
  perspective?: string;
  location?: ScalarObject;
  target?: Target;
  signature: Signature;
}
export interface ProviderBinding {
  profileId: StableKey;
  installationId: string;
  objectId: string;
}
export interface StoredScope {
  workspace: StableKey;
  resource: ResourceRef;
  application: StableKey;
  environment: StableKey;
}
export interface ResourceRef {
  kind: StableKey;
  key: string;
}
export interface CreatedBy {
  participantId: StableId;
}
export interface ScalarObject {
  [k: string]: Scalar;
}
export interface Target {
  kind: StableKey;
  provider?: string;
  targetKey: string;
  metadata?: ScalarObject;
}
export interface Signature {
  alg: "HS256";
  kid: string;
  value: string;
}
