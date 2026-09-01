/* このファイルはfeedback-message-marker.schema.jsonから生成されます。手編集しないでください。 */

/**
 * 親threadのprovider bindingへ束縛する署名付きmessage marker
 */
export type FeedbackMessageMarkerV2 = {
  [k: string]: unknown;
} & {
  schemaVersion: "2";
  threadId: string;
  eventId: string;
  eventKind: "reply" | "revision";
  messageId: string;
  expectedRevisionId?: string;
  intentId: string;
  requestHash: string;
  participantId: string;
  bodyHash: string;
  providerBinding: {
    profileId: string;
    installationId: string;
    objectId: string;
  };
  createdAt: string;
  signature: {
    alg: "HS256";
    kid: string;
    value: string;
  };
};
