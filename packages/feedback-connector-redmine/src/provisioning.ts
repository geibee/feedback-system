import type {
  FeedbackRedmineProfileV2,
  RedmineCustomFieldIdsV2,
  RedmineProviderCustomField,
  RedmineV2ProvisioningPlan,
  RedmineProvisioningField
} from "./redmine-types.js";

/** v1 fieldを再利用しつつ、v2 artifactだけを非公開custom fieldへ分離する。 */
export const feedbackRedmineV2ProvisioningFields = Object.freeze([
  { key: "threadId", name: "Feedback Thread ID", format: "string", searchable: true },
  { key: "intentId", name: "Feedback v2 Intent ID", format: "string", searchable: false },
  { key: "requestHash", name: "Feedback Request Hash", format: "string", searchable: false },
  { key: "envelope", name: "Feedback v2 Envelope", format: "text", searchable: false },
  { key: "projection", name: "Feedback v2 Projection", format: "text", searchable: false },
  { key: "applicationKey", name: "Feedback Application", format: "string", searchable: true },
  { key: "environmentKey", name: "Feedback Environment", format: "string", searchable: true },
  { key: "externalWorkspaceKey", name: "Feedback Workspace", format: "string", searchable: true },
  { key: "hostResourceKey", name: "Feedback Host Resource", format: "string", searchable: true }
] as const satisfies readonly RedmineProvisioningField[]);

export type RedmineProvisioningInspection = {
  ready: boolean;
  missing: Array<keyof RedmineCustomFieldIdsV2>;
  duplicateIds: number[];
};

/** ops laneがplan/applyする前に、名前・型・検索可否の競合を決定論的に洗い出す。 */
export function planRedmineV2Provisioning(
  providerFields: readonly RedmineProviderCustomField[]
): RedmineV2ProvisioningPlan {
  const operations: RedmineV2ProvisioningPlan["operations"] = [];
  for (const expected of feedbackRedmineV2ProvisioningFields) {
    const matches = providerFields.filter((field) => field.name === expected.name);
    if (matches.length === 0) {
      operations.push({ key: expected.key, action: "create", detail: `${expected.name}を作成` });
      continue;
    }
    if (matches.length > 1) {
      operations.push({ key: expected.key, action: "conflict", detail: `${expected.name}がprovider上で重複` });
      continue;
    }
    const actual = matches[0]!;
    if (actual.format !== expected.format || actual.searchable !== expected.searchable) {
      operations.push({
        key: expected.key,
        action: "conflict",
        providerFieldId: actual.id,
        detail: `${expected.name}のformat/searchableが契約と不一致`
      });
      continue;
    }
    operations.push({ key: expected.key, action: "reuse", providerFieldId: actual.id, detail: `${expected.name}を再利用` });
  }
  return { ready: operations.every((operation) => operation.action === "reuse"), operations };
}

/** 実providerへの変更はops ownerが行い、Connectorは起動時に不足をfail-closedにする。 */
export function inspectRedmineV2Provisioning(
  customFieldIds: Partial<RedmineCustomFieldIdsV2>
): RedmineProvisioningInspection {
  const missing = feedbackRedmineV2ProvisioningFields
    .map((field) => field.key)
    .filter((key) => !Number.isInteger(customFieldIds[key]) || Number(customFieldIds[key]) <= 0);
  const ids = Object.values(customFieldIds).filter((value): value is number => Number.isInteger(value) && value > 0);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  return { ready: missing.length === 0 && duplicates.length === 0, missing, duplicateIds: [...new Set(duplicates)] };
}

export function assertFeedbackRedmineProfile(profile: FeedbackRedmineProfileV2): void {
  const inspection = inspectRedmineV2Provisioning(profile.customFieldIds);
  if (!inspection.ready) {
    throw new Error(`Redmine v2 provisioningが未完了です: missing=${inspection.missing.join(",")}; duplicate=${inspection.duplicateIds.join(",")}`);
  }
  for (const key of [
    profile.profileId,
    profile.installationId,
    profile.applicationKey,
    profile.environmentKey,
    profile.workspaceId,
    profile.participantId
  ]) {
    if (!key) throw new Error("Redmine v2 profileの識別子が空です");
  }
  if (!Number.isInteger(profile.projectId) || profile.projectId <= 0 ||
    !Number.isInteger(profile.trackerId) || profile.trackerId <= 0) {
    throw new Error("Redmine v2 profileのproject/tracker IDが不正です");
  }
  if (!Number.isSafeInteger(profile.maximumAttachmentBytes) || profile.maximumAttachmentBytes <= 0 ||
    profile.attachmentContentTypes.length === 0) {
    throw new Error("Redmine v2 profileのattachment policyが不正です");
  }
}
