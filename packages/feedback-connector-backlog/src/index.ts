export * from "./connector.js";
export * from "./contract-fixture.js";
export * from "./http-transport.js";
export * from "./provisioning.js";
export * from "./rest-v2-client.js";
export * from "./types.js";
import type { FeedbackRepositoryPort } from "@geibee/feedback-connector-sdk";
import type { BacklogConnectorOptions } from "./connector.js";

export type FeedbackBacklogConnectorFactory = (options: BacklogConnectorOptions) => FeedbackRepositoryPort;
export const feedbackBacklogConnectorKey = "backlog" as const;
