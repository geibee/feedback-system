/* このファイルはfeedback-attachment-marker.schema.jsonから生成されます。手編集しないでください。 */

/**
 * stable attachment IDをprovider attachmentへ対応付けるserver-only署名marker
 */
export interface FeedbackAttachmentMarkerV2 {
  schemaVersion: "2";
  threadId: string;
  messageId: string;
  attachmentId: string;
  intentId: string;
  requestHash: string;
  providerBinding: {
    profileId: string;
    installationId: string;
    objectId: string;
  };
  providerAttachmentId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  contentHash: string;
  createdAt: string;
  signature: {
    alg: "HS256";
    kid: string;
    value: string;
  };
}
