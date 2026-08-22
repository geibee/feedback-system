import type { RedmineConnectorProfile, RedmineFetch } from "@geibee/feedback-redmine-core/trusted";
import type { RedmineCreationOptionsV1 } from "@geibee/feedback-contracts";

export type GatewayServerProfile = RedmineConnectorProfile & {
  authorizationMode: "resource-scoped";
  secretRef: string;
  optionalIssueFields?: RedmineCreationOptionsV1["optionalIssueFields"];
};

export type GatewayDependencies = {
  participantSigningKey: string | Uint8Array;
  loadProfile(profileId: string): Promise<GatewayServerProfile | null>;
  loadSecret(secretRef: string): Promise<string | null>;
  fetch: RedmineFetch;
  allowHttpDevelopment?: boolean;
  basePath?: string;
  maximumRequestBytes?: number;
  metric?: (metric: {
    operation: string;
    profileId: string;
    status: number;
    durationMilliseconds: number;
  }) => void;
};
