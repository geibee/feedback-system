import type { RedmineConnectorProfile, RedmineFetch } from "@feedback/redmine-core/trusted";

export type GatewayServerProfile = RedmineConnectorProfile & {
  authorizationMode: "resource-scoped";
  secretRef: string;
};

export type GatewayDependencies = {
  host: import("./auth.js").FeedbackRedmineGatewayHost;
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
