export type RedmineNamedDto = { id?: unknown; name?: unknown };

export type RedmineCustomFieldDto = {
  id?: unknown;
  name?: unknown;
  value?: unknown;
};

export type RedmineIssueDto = {
  id?: unknown;
  subject?: unknown;
  description?: unknown;
  status?: unknown;
  priority?: unknown;
  assigned_to?: unknown;
  author?: unknown;
  tracker?: unknown;
  created_on?: unknown;
  updated_on?: unknown;
  custom_fields?: unknown;
  attachments?: unknown;
  journals?: unknown;
};

export type RedmineIssuesDto = {
  issues?: unknown;
  total_count?: unknown;
  offset?: unknown;
  limit?: unknown;
};

export type RedmineUploadDto = {
  upload?: unknown;
};

export type RedmineAttachmentDto = {
  attachment?: unknown;
};
