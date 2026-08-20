# frozen_string_literal: true

# Feedback Redmineの名前ベースplan/apply provisioner。
# customer Redmineではplan digestを確認しない限り変更しない。
require "digest"
require "fileutils"
require "json"
require "securerandom"

MANAGED_MARKER = "[feedback-redmine-managed-v1]"
FIELD_SPECS = {
  "threadId" => ["Feedback Thread ID", "string", true],
  "requestHash" => ["Feedback Request Hash", "string", false],
  "applicationKey" => ["Feedback Application", "string", true],
  "environmentKey" => ["Feedback Environment", "string", true],
  "externalWorkspaceKey" => ["Feedback Workspace", "string", true],
  "pageKey" => ["Feedback Page", "string", true],
  "hostResourceKey" => ["Feedback Host Resource", "string", true],
  "perspectiveCode" => ["Feedback Perspective", "string", true],
  "locator" => ["Feedback Locator", "text", false],
  "submittedById" => ["Feedback Submitted By ID", "string", false],
  "submittedByName" => ["Feedback Submitted By Name", "string", false]
}.freeze

def fail_with(message)
  raise "Feedback Redmine provisioner: #{message}"
end

def load_manifest(path)
  value = JSON.parse(File.read(path, encoding: "UTF-8"))
  required = %w[
    schemaVersion profileId displayName applicationKey environmentKey externalWorkspaceKey redmineBaseUrl project
    trackerName openStatusName closedStatusName defaultPriorityName roleName integrationUser isPrivate captureEnabled
    showRedmineLink
  ]
  fail_with("installation manifestのshapeが不正です") unless value.is_a?(Hash) && value.keys.sort == required.sort
  fail_with("schemaVersionは1である必要があります") unless value["schemaVersion"] == "1"
  fail_with("projectが不正です") unless value["project"].is_a?(Hash) && value["project"].keys.sort == %w[identifier name]
  fail_with("integrationUserが不正です") unless value["integrationUser"].is_a?(Hash) &&
    value["integrationUser"].keys.sort == %w[firstName lastName login mail]
  value
rescue JSON::ParserError
  fail_with("installation manifestをJSONとして読めません")
end

def desired_permissions(manifest)
  permissions = %i[view_issues add_issues edit_issues add_issue_notes view_private_notes]
  permissions << :set_issues_private if manifest["isPrivate"]
  permissions
end

def plan_for(manifest)
  operations = []
  conflicts = []
  open_status = IssueStatus.find_by(name: manifest["openStatusName"])
  closed_status = IssueStatus.find_by(name: manifest["closedStatusName"])
  assess(operations, conflicts, "status.open", open_status, open_status.nil? || !open_status.is_closed,
    "open statusを作成", "既存open statusを再利用", "同名statusがclosedです")
  assess(operations, conflicts, "status.closed", closed_status, closed_status.nil? || closed_status.is_closed,
    "closed statusを作成", "既存closed statusを再利用", "同名statusがopenです")

  tracker = Tracker.find_by(name: manifest["trackerName"])
  tracker_ok = tracker.nil? || open_status.nil? || tracker.default_status_id.nil? || tracker.default_status_id == open_status.id
  assess(operations, conflicts, "tracker", tracker, tracker_ok,
    "trackerを作成", "既存trackerを再利用", "既存trackerのdefault statusが異なります")

  priority = IssuePriority.find_by(name: manifest["defaultPriorityName"])
  assess(operations, conflicts, "priority", priority, priority.nil? || priority.active?,
    "priorityを作成", "既存priorityを再利用", "既存priorityが無効です")

  role = Role.find_by(name: manifest["roleName"])
  role_ok = role.nil? || (role.permissions.map(&:to_sym).sort == desired_permissions(manifest).sort && role.issues_visibility == "all")
  assess(operations, conflicts, "role", role, role_ok,
    "最小権限roleを作成", "既存roleを再利用", "既存roleの権限またはissue visibilityが一致しません")

  if tracker && role && open_status && closed_status
    desired_transitions = [open_status.id, closed_status.id].product([open_status.id, closed_status.id]).sort
    actual_transitions = WorkflowTransition.where(
      tracker_id: tracker.id,
      role_id: role.id,
      author: false,
      assignee: false
    ).pluck(:old_status_id, :new_status_id).uniq.sort
    if actual_transitions == desired_transitions
      operations << { "key" => "workflow", "action" => "reuse", "detail" => "4件のstatus遷移を再利用" }
    else
      conflicts << {
        "key" => "workflow",
        "detail" => "既存workflowが必要なopen/closed間4遷移と一致しません",
        "expected" => desired_transitions,
        "actual" => actual_transitions
      }
    end
  else
    operations << { "key" => "workflow", "action" => "create", "detail" => "open/closed間の4遷移を作成" }
  end

  user_spec = manifest["integrationUser"]
  user = User.find_by(login: user_spec["login"])
  user_ok = user.nil? || (user.mail == user_spec["mail"] && user.firstname == user_spec["firstName"] &&
    user.lastname == user_spec["lastName"] && user.active?)
  assess(operations, conflicts, "integration-user", user, user_ok,
    "integration userを作成", "既存integration userを再利用", "既存userの属性または状態が一致しません")

  project_spec = manifest["project"]
  project = Project.find_by(identifier: project_spec["identifier"])
  project_ok = project.nil? || (project.name == project_spec["name"] && project.description.to_s.include?(MANAGED_MARKER))
  assess(operations, conflicts, "project", project, project_ok,
    "private Feedback projectを作成", "管理対象projectを再利用", "既存projectはFeedback管理対象ではありません")

  FIELD_SPECS.each do |key, spec|
    name, format, filter = spec
    field = IssueCustomField.find_by(name: name)
    assignments_match = field && tracker && role && project &&
      field.tracker_ids.sort == [tracker.id] &&
      (!field.respond_to?(:role_ids) || field.role_ids.sort == [role.id]) &&
      (!field.respond_to?(:project_ids) || field.project_ids.sort == [project.id])
    field_ok = field.nil? || (assignments_match && field.field_format == format && !field.is_for_all &&
      (!field.respond_to?(:is_filter) || field.is_filter == filter) &&
      (!field.respond_to?(:searchable) || field.searchable == filter))
    assess(operations, conflicts, "custom-field.#{key}", field, field_ok,
      "#{name}を作成", "既存#{name}を再利用", "既存#{name}の形式・公開範囲・索引設定が一致しません")
  end

  body = {
    "schemaVersion" => "1",
    "redmineVersion" => Redmine::VERSION.to_s,
    "profileId" => manifest["profileId"],
    "operations" => operations,
    "conflicts" => conflicts
  }
  body["planDigest"] = Digest::SHA256.hexdigest(JSON.generate(body))
  body
end

def assess(operations, conflicts, key, record, valid, create_detail, reuse_detail, conflict_detail)
  if record.nil?
    operations << { "key" => key, "action" => "create", "detail" => create_detail }
  elsif valid
    operations << { "key" => key, "action" => "reuse", "id" => record.id, "detail" => reuse_detail }
  else
    conflicts << { "key" => key, "id" => record.id, "detail" => conflict_detail }
  end
end

def write_private(path, value)
  FileUtils.mkdir_p(File.dirname(path), mode: 0o700)
  temporary = "#{path}.tmp-#{Process.pid}-#{SecureRandom.hex(4)}"
  File.open(temporary, File::WRONLY | File::CREAT | File::EXCL, 0o600) { |file| file.write(value) }
  File.chmod(0o600, temporary)
  File.rename(temporary, path)
ensure
  File.delete(temporary) if defined?(temporary) && File.exist?(temporary)
end

def write_public(path, value)
  write_private(path, value)
  File.chmod(0o644, path)
end

def apply_manifest(manifest, output_directory, local_evaluation)
  Setting.rest_api_enabled = "1"

  open_status = IssueStatus.find_or_create_by!(name: manifest["openStatusName"]) do |record|
    record.position = 1
    record.is_closed = false
    record.is_default = true if record.respond_to?(:is_default=)
  end
  closed_status = IssueStatus.find_or_create_by!(name: manifest["closedStatusName"]) do |record|
    record.position = 2
    record.is_closed = true
  end
  tracker = Tracker.find_or_create_by!(name: manifest["trackerName"]) do |record|
    record.position = 1
    record.default_status = open_status
  end
  tracker.update!(default_status: open_status)
  priority = IssuePriority.find_or_create_by!(name: manifest["defaultPriorityName"]) do |record|
    record.position = 1
    record.is_default = true
    record.active = true
  end
  role = Role.find_or_create_by!(name: manifest["roleName"]) do |record|
    record.position = 1
    record.issues_visibility = "all"
    record.users_visibility = "all" if record.respond_to?(:users_visibility=)
    record.permissions = desired_permissions(manifest)
  end

  user_spec = manifest["integrationUser"]
  user = User.find_or_initialize_by(login: user_spec["login"])
  if user.new_record?
    password = SecureRandom.base64(48)
    user.password = password
    user.password_confirmation = password
  end
  user.firstname = user_spec["firstName"]
  user.lastname = user_spec["lastName"]
  user.mail = user_spec["mail"]
  user.status = User::STATUS_ACTIVE
  user.save!

  project_spec = manifest["project"]
  project = Project.find_or_initialize_by(identifier: project_spec["identifier"])
  project.name = project_spec["name"]
  project.description = "#{MANAGED_MARKER}\nFeedback Redmine integration project"
  project.is_public = false
  project.enabled_module_names = ["issue_tracking"]
  project.tracker_ids = [tracker.id]
  project.save!
  member = Member.find_or_initialize_by(project: project, user: user)
  member.role_ids = [role.id]
  member.save!

  [open_status, closed_status].product([open_status, closed_status]).each do |old_value, new_value|
    WorkflowTransition.find_or_create_by!(
      tracker_id: tracker.id,
      role_id: role.id,
      old_status_id: old_value.id,
      new_status_id: new_value.id,
      author: false,
      assignee: false
    )
  end

  custom_field_ids = {}
  FIELD_SPECS.each do |key, spec|
    name, format, filter = spec
    field = IssueCustomField.find_or_initialize_by(name: name)
    field.field_format = format
    field.is_for_all = false
    field.is_filter = filter if field.respond_to?(:is_filter=)
    field.searchable = filter if field.respond_to?(:searchable=)
    field.tracker_ids = [tracker.id]
    field.role_ids = [role.id] if field.respond_to?(:role_ids=)
    field.project_ids = [project.id] if field.respond_to?(:project_ids=)
    field.save!
    custom_field_ids[key] = field.id
  end

  token = Token.find_or_create_by!(user: user, action: "api")
  client_profile = {
    "schemaVersion" => "1",
    "id" => manifest["profileId"],
    "displayName" => manifest["displayName"],
    "applicationKey" => manifest["applicationKey"],
    "environmentKey" => manifest["environmentKey"],
    "externalWorkspaceKey" => manifest["externalWorkspaceKey"],
    "perspectives" => [{ "code" => "general", "label" => "一般" }],
    "capture" => {
      "enabled" => manifest["captureEnabled"],
      "maximumUploadBytes" => 10_485_760,
      "contentTypes" => ["image/png", "image/webp"]
    },
    "attachments" => { "maximumInlinePreviewBytes" => 10_485_760, "maximumDownloadBytes" => 52_428_800 },
    "showRedmineLink" => manifest["showRedmineLink"]
  }
  server_profile = {
    "profileId" => manifest["profileId"],
    "clientProfileRef" => "client-profile.json",
    "redmineBaseUrl" => manifest["redmineBaseUrl"],
    "projectId" => project.id,
    "trackerId" => tracker.id,
    "isPrivate" => manifest["isPrivate"],
    "defaultPriorityId" => priority.id,
    "closedStatusIds" => [closed_status.id],
    "customFieldIds" => custom_field_ids,
    "authorizationMode" => "resource-scoped",
    "showRedmineLink" => manifest["showRedmineLink"],
    "secretRef" => "FEEDBACK_REDMINE_GATEWAY_API_KEY"
  }
  runtime_config = {
    "schemaVersion" => "1",
    "enabled" => true,
    "profileId" => manifest["profileId"],
    "gatewayBasePath" => "/internal/feedback-redmine/v1"
  }
  result = {
    "schemaVersion" => "1",
    "redmineVersion" => Redmine::VERSION.to_s,
    "projectId" => project.id,
    "trackerId" => tracker.id,
    "openStatusId" => open_status.id,
    "closedStatusId" => closed_status.id,
    "defaultPriorityId" => priority.id,
    "integrationUserId" => user.id,
    "customFieldIds" => custom_field_ids
  }
  write_private(File.join(output_directory, "client-profile.json"), "#{JSON.pretty_generate(client_profile)}\n")
  write_private(File.join(output_directory, "server-profile.json"), "#{JSON.pretty_generate(server_profile)}\n")
  write_public(File.join(output_directory, "runtime-config.json"), "#{JSON.pretty_generate(runtime_config)}\n")
  write_private(File.join(output_directory, "provision-result.json"), "#{JSON.pretty_generate(result)}\n")
  write_private(File.join(output_directory, "redmine-api-key"), "#{token.value}\n")

  return unless local_evaluation
  fail_with("local evaluationのproject identifierが不正です") unless project.identifier == "feedback-local"
  admin_password_path = File.join(output_directory, "redmine-admin-password")
  unless File.exist?(admin_password_path)
    admin = User.find_by(login: "admin")
    fail_with("local Redmineのadmin userが見つかりません") unless admin
    admin_password = SecureRandom.base64(36)
    admin.password = admin_password
    admin.password_confirmation = admin_password
    admin.must_change_passwd = false if admin.respond_to?(:must_change_passwd=)
    admin.save!
    write_private(admin_password_path, "#{admin_password}\n")
  end
end

mode, manifest_path, output_directory, confirmation = ARGV
fail_with("usage: provision.rb <plan|apply> <manifest.json> <output-directory> [plan-digest|--local-evaluation]") unless
  %w[plan apply].include?(mode) && manifest_path && output_directory
manifest = load_manifest(manifest_path)
plan = plan_for(manifest)
FileUtils.mkdir_p(output_directory, mode: 0o700)
write_private(File.join(output_directory, "provision-plan.json"), "#{JSON.pretty_generate(plan)}\n")

if mode == "plan"
  puts JSON.pretty_generate(plan)
  exit(plan["conflicts"].empty? ? 0 : 2)
end
fail_with("競合があるためapplyできません") unless plan["conflicts"].empty?
local_evaluation = confirmation == "--local-evaluation"
unless local_evaluation
  fail_with("plan digestの確認が必要です") unless confirmation == plan["planDigest"]
end
apply_manifest(manifest, output_directory, local_evaluation)
puts JSON.generate({ "status" => "applied", "planDigest" => plan["planDigest"] })
