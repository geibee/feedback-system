import { RedmineFeedbackError } from "@geibee/feedback-redmine-core";

export function feedbackErrorMessage(
  error: unknown,
  target: "接続" | "一覧" | "詳細" | "投稿" | "返信" | "編集" | "添付ファイル" | "画面移動"
): string {
  if (!(error instanceof RedmineFeedbackError)) return `${target}を完了できません。時間をおいて再試行してください。`;
  if (error.code === "redmine.invalid_api_key" || error.code === "redmine.unauthenticated") {
    return "Redmineの認証を確認できません。管理者にgatewayのRedmine認証設定を確認してもらってください。";
  }
  if (error.code === "redmine.permission_denied") return `${target}に必要なRedmine project権限がありません。管理者へ確認してください。`;
  if (error.code === "redmine.not_found") return `${target}の対象が削除されたか、現在のprofileから参照できません。`;
  if (error.code === "redmine.duplicate_thread_id") return "同じthread IDのissueが複数あります。Redmine管理者へ連絡してください。";
  if (error.code === "redmine.thread_mismatch") return "既存threadのscopeまたは投稿情報が一致しません。Redmine管理者へ連絡してください。";
  if (error.code === "redmine.payload_too_large") return `${target}のデータが許可された上限を超えています。`;
  if (error.code === "redmine.content_type_rejected") return "添付ファイルの形式が許可されていません。";
  if (error.code === "redmine.validation_failed") return "Redmineの入力検証に失敗しました。profileと必須custom fieldを確認してください。";
  if (error.code === "redmine.rate_limited") return "Redmineの利用上限に達しました。時間をおいて手動で再試行してください。";
  if (error.code === "redmine.contract_invalid" || error.code === "feedback.locator_too_large") {
    return `${target}のresponseまたは設定がFeedback契約に適合しません。管理者へ連絡してください。`;
  }
  return `Redmineへ接続できず${target}を完了できません。draftを保持したまま手動で再試行してください。`;
}
