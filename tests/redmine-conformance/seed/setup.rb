require "json"
require "securerandom"

Setting.rest_api_enabled = "1"
Setting.default_language = "en"

open_status = IssueStatus.find_or_create_by!(name: "New") do |record|
  record.position = 1
  record.is_closed = false
  record.is_default = true if record.respond_to?(:is_default=)
end
closed_status = IssueStatus.find_or_create_by!(name: "Closed") do |record|
  record.position = 2
  record.is_closed = true
end
tracker = Tracker.find_or_create_by!(name: "Feedback") do |record|
  record.position = 1
  record.default_status = open_status
end
tracker.update!(default_status: open_status)
normal_priority = IssuePriority.find_or_create_by!(name: "Normal") do |record|
  record.position = 1
  record.is_default = true
  record.active = true
end
high_priority = IssuePriority.find_or_create_by!(name: "High") do |record|
  record.position = 2
  record.active = true
end

role = Role.find_or_create_by!(name: "Feedback integration") do |record|
  record.position = 1
  record.issues_visibility = "all"
  record.users_visibility = "all" if record.respond_to?(:users_visibility=)
  record.permissions = %i[view_issues add_issues edit_issues add_issue_notes view_private_notes]
end
role.update!(permissions: %i[view_issues add_issues edit_issues add_issue_notes view_private_notes])

user = User.find_or_initialize_by(login: "feedback_integration")
user.firstname = "Feedback"
user.lastname = "Integration"
user.mail = "feedback-integration@example.invalid"
user.status = User::STATUS_ACTIVE
password = SecureRandom.hex(32)
user.password = password
user.password_confirmation = password
user.save!

project = Project.find_or_initialize_by(identifier: "feedback-conformance")
project.name = "Feedback Conformance"
project.description = "Local Docker conformance fixture"
project.is_public = false
project.enabled_module_names = ["issue_tracking"]
project.tracker_ids = [tracker.id]
project.save!
Member.find_or_create_by!(project: project, user: user) { |member| member.role_ids = [role.id] }.update!(role_ids: [role.id])

[[open_status, open_status], [open_status, closed_status], [closed_status, open_status], [closed_status, closed_status]].each do |old_value, new_value|
  WorkflowTransition.find_or_create_by!(
    tracker_id: tracker.id,
    role_id: role.id,
    old_status_id: old_value.id,
    new_status_id: new_value.id,
    author: false,
    assignee: false
  )
end

field_specs = {
  threadId: ["Feedback Thread ID", "string", true],
  requestHash: ["Feedback Request Hash", "string", false],
  applicationKey: ["Feedback Application", "string", true],
  environmentKey: ["Feedback Environment", "string", true],
  externalWorkspaceKey: ["Feedback Workspace", "string", true],
  pageKey: ["Feedback Page", "string", true],
  hostResourceKey: ["Feedback Host Resource", "string", true],
  perspectiveCode: ["Feedback Perspective", "string", true],
  locator: ["Feedback Locator", "text", false],
  submittedById: ["Feedback Submitted By ID", "string", false],
  submittedByName: ["Feedback Submitted By Name", "string", false],
  submissionChannel: ["Feedback Submission Channel", "string", true]
}
custom_field_ids = field_specs.to_h do |key, (name, format, filter)|
  field = IssueCustomField.find_or_initialize_by(name: name)
  field.field_format = format
  field.is_for_all = true
  field.is_filter = filter if field.respond_to?(:is_filter=)
  field.searchable = filter if field.respond_to?(:searchable=)
  field.tracker_ids = [tracker.id]
  field.role_ids = [role.id] if field.respond_to?(:role_ids=)
  field.save!
  [key, field.id]
end

token = Token.find_or_create_by!(user: user, action: "api")
puts JSON.generate({
  version: Redmine::VERSION.to_s,
  apiKey: token.value,
  userId: user.id,
  projectId: project.id,
  trackerId: tracker.id,
  openStatusId: open_status.id,
  closedStatusId: closed_status.id,
  normalPriorityId: normal_priority.id,
  highPriorityId: high_priority.id,
  customFieldIds: custom_field_ids
})
