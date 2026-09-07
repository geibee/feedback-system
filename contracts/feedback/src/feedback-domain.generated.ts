/* このファイルはfeedback-domain.schema.jsonから生成されます。手編集しないでください。 */

export type StableKey = string;
export type StableId = string;

/**
 * provider非依存のscope、stable ordering、cursor fingerprint契約
 */
export interface FeedbackDomainV2 {
  schemaVersion: "2";
  scope: FeedbackScopeV2;
  orderingKey: FeedbackOrderingKeyV2;
}
export interface FeedbackScopeV2 {
  profileId: StableKey;
  workspaceId: StableKey;
  resource: FeedbackResourceRefV2;
}
export interface FeedbackResourceRefV2 {
  kind: StableKey;
  key: string;
}
export interface FeedbackOrderingKeyV2 {
  occurredAt: string;
  eventId: StableId;
}
