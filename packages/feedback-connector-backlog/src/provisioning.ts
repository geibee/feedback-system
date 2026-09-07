import { BacklogRestV2Client } from "./rest-v2-client.js";
import type { BacklogConnectorConfiguration } from "./types.js";

/** Backlog project側の検索projectionと作成fieldをread-onlyで検証する。 */
export async function assertFeedbackBacklogProvisioning(
  client: BacklogRestV2Client,
  profile: Pick<BacklogConnectorConfiguration, "projectId" | "workspaceId" | "issueTypeId" | "priorityId" | "customFieldIds">
): Promise<void> {
  const [project, fields, issueTypes, priorities] = await Promise.all([
    client.getProject(profile.projectId),
    client.getCustomFields(profile.projectId),
    client.getIssueTypes(profile.projectId),
    client.getPriorities()
  ]);
  if (project.archived || project.projectKey !== profile.workspaceId) throw new Error("Backlog project readinessが不正です");
  const expected = [
    ["threadId", "feedback.threadId"],
    ["intentId", "feedback.intentId"],
    ["requestHash", "feedback.requestHash"],
    ["resourceKey", "feedback.resourceKey"]
  ] as const;
  for (const [key, name] of expected) {
    const field = fields.find((candidate) => candidate.id === profile.customFieldIds[key]);
    if (!field || field.name !== name || field.typeId !== 1 || field.required) throw new Error(`Backlog ${name} readinessが不正です`);
  }
  if (!issueTypes.some((candidate) => candidate.id === profile.issueTypeId)) throw new Error("Backlog issueTypeId readinessが不正です");
  if (!priorities.some((candidate) => candidate.id === profile.priorityId)) throw new Error("Backlog priorityId readinessが不正です");
}
