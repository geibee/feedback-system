import type { RedmineConnectorProfile, RedmineFetch } from "@feedback/redmine-core/trusted";

export type GatewayServerProfile = RedmineConnectorProfile & {
  authorizationMode: "resource-scoped";
  secretRef: string;
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
