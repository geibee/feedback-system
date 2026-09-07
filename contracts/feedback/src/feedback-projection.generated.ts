/* このファイルはfeedback-projection.schema.jsonから生成されます。手編集しないでください。 */

/**
 * 候補抽出専用の未信頼projection。単独では返却・認可・回復完了の根拠にしない
 */
export interface FeedbackProjectionV2 {
  schemaVersion: "2";
  threadId: string;
  intentId: string;
  requestHash: string;
  profileId: string;
  workspaceId: string;
  resource: {
    kind: string;
    key: string;
  };
}
