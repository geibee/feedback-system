import type { FeedbackHostResourceRefV1 } from "@feedback/redmine-core";

export type GatewayHostPrincipal = {
  subjectId: string;
  displayName: string | null;
  redmineUserId: number | null;
};

export type AuthorizedHostResource = {
  resourceKey: string;
};

export type FeedbackRedmineGatewayHost = {
  authenticate(request: Request): Promise<GatewayHostPrincipal | null>;
  authorizeProfile(input: {
    principal: GatewayHostPrincipal;
    operation: "read" | "create";
    profileId: string;
  }): Promise<boolean>;
  authorizeResource(input: {
    principal: GatewayHostPrincipal;
    operation: "list" | "create";
    profileId: string;
    resourceRef: FeedbackHostResourceRefV1;
  }): Promise<AuthorizedHostResource | null>;
  authorizeStoredResource(input: {
    principal: GatewayHostPrincipal;
    operation: "detail" | "attachment";
    profileId: string;
    storedResourceKey: string;
  }): Promise<boolean>;
  verifyCsrf(input: {
    request: Request;
    principal: GatewayHostPrincipal;
    token: string;
  }): Promise<boolean>;
};
