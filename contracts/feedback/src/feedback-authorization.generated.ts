/* このファイルはfeedback-authorization.schema.jsonから生成されます。手編集しないでください。 */

/**
 * signed grant claimsとremote authorization request/decisionのserver-side契約
 */
export type FeedbackAuthorizationContractV2 =
  SignedGrantClaimsV2 | RemoteAuthorizationRequestV2 | RemoteAuthorizationDecisionV2;
export type SignedGrantClaimsV2 = {
  [k: string]: unknown;
} & {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  nbf?: number;
  jti?: string;
  scope: string;
  feedback_grant_kind: "oidc" | "token-exchange";
  feedback_profile_id: string;
  feedback_workspace_id: string;
  feedback_resource: Resource;
  azp?: string;
  client_id?: string;
  act?: Actor;
};
export type AuthorizationTarget = ProfileTarget | WorkspaceTarget | ResourceTarget;
export type Operation =
  | "feedback:read"
  | "feedback:create"
  | "feedback:reply"
  | "feedback:revise"
  | "feedback:attachment:read"
  | "feedback:attachment:upload";

export interface Resource {
  kind: "workspace" | "record" | "page";
  key: string;
}
export interface Actor {
  sub: string;
}
export interface RemoteAuthorizationRequestV2 {
  schemaVersion: "1";
  target: AuthorizationTarget;
  /**
   * @minItems 1
   */
  requestedOperations: [Operation, ...Operation[]];
  subject: RemoteSubject;
}
export interface ProfileTarget {
  level: "profile";
  profileId: string;
}
export interface WorkspaceTarget {
  level: "workspace";
  profileId: string;
  workspaceId: string;
}
export interface ResourceTarget {
  level: "resource";
  profileId: string;
  workspaceId: string;
  resource: Resource;
}
export interface RemoteSubject {
  id: string;
  source: "authenticated-adapter";
}
export interface RemoteAuthorizationDecisionV2 {
  schemaVersion: "1";
  target: AuthorizationTarget;
  subject: RemoteSubject;
  allowedOperations: Operation[];
}
