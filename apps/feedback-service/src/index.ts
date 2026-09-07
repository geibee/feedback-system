import type { FeedbackProviderProfileV2 } from "@geibee/feedback-contracts/v2/server";
import type { FeedbackAuthorizationMode, FeedbackProfileLoaderPort } from "@geibee/feedback-gateway";

export * from "./authorization.js";
export * from "./configuration.js";
export * from "./http.js";
export * from "./participant.js";
export * from "./service.js";
export * from "./v1-facade.js";

const authorizationModes = new Set<FeedbackAuthorizationMode>([
  "public-profile",
  "signed-grant",
  "remote-authorization"
]);

export function createFakeFeedbackProfileLoader(
  profiles: readonly FeedbackProviderProfileV2[]
): FeedbackProfileLoaderPort {
  const profileIds = new Set<string>();
  const snapshot = profiles.map((profile) => {
    if (profileIds.has(profile.profileId)) {
      throw new Error(`provider profile IDが重複しています: ${profile.profileId}`);
    }
    profileIds.add(profile.profileId);
    if (!authorizationModes.has(profile.authorization.mode)) {
      throw new Error(`未対応のAuthorization Modeです: ${String(profile.authorization.mode)}`);
    }
    return Object.freeze(profile);
  });

  return Object.freeze({
    loadProfiles: async () => snapshot
  });
}
