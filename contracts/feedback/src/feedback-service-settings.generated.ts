/* このファイルはfeedback-service-settings.schema.jsonから生成されます。手編集しないでください。 */

export type StableKey = string;

/**
 * DBレスFeedback Serviceの非secret起動設定
 */
export interface FeedbackServiceSettingsV2 {
  schemaVersion: "2";
  serviceId: string;
  /**
   * @minItems 1
   * @maxItems 100
   */
  profileFiles: [string, ...string[]];
  /**
   * @maxItems 32
   */
  signedGrantIssuers: SignedGrantIssuerProfile[];
  /**
   * @maxItems 100
   */
  remoteAuthorizationProfiles: RemoteAuthorizationProfile[];
  jwksCache: {
    maximumIssuers: number;
    maximumKeysPerIssuer: number;
    maximumTtlSeconds: number;
  };
}
export interface SignedGrantIssuerProfile {
  id: StableKey;
  issuer: string;
  jwksUri: string;
  algorithm: "RS256" | "ES256" | "EdDSA";
  grant: OidcIssuer | TokenExchangeIssuer;
}
export interface OidcIssuer {
  grantKind: "oidc";
  clientId: string;
}
export interface TokenExchangeIssuer {
  grantKind: "token-exchange";
  clientId: string;
  actorId: string;
}
export interface RemoteAuthorizationProfile {
  id: StableKey;
  endpoint: string;
  timeoutMilliseconds: 2000;
  credentialRef: SecretReference;
}
export interface SecretReference {
  kind: "server-secret";
  id: string;
}
