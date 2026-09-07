# frozen_string_literal: true

# Rails runnerから実行するFeedback v2専用custom field plan/apply。
# v1の11 fieldは変更せず、v2で追加する3 fieldだけを作成する。
require "digest"
require "fileutils"
require "json"
require "securerandom"

FIELD_SPECS = {
  "threadId" => ["Feedback Thread ID", "string", true, false],
  "intentId" => ["Feedback v2 Intent ID", "string", false, true],
  "requestHash" => ["Feedback Request Hash", "string", false, false],
  "envelope" => ["Feedback v2 Envelope", "text", false, true],
  "projection" => ["Feedback v2 Projection", "text", false, true],
  "applicationKey" => ["Feedback Application", "string", true, false],
  "environmentKey" => ["Feedback Environment", "string", true, false],
  "externalWorkspaceKey" => ["Feedback Workspace", "string", true, false],
  "hostResourceKey" => ["Feedback Host Resource", "string", true, false]
}.freeze
CREATION_KEYS = %w[intentId envelope projection].freeze

def fail_with(message)
  raise "Feedback Redmine v2 custom fields: #{message}"
end

def load_config(path)
  value = JSON.parse(File.read(path, encoding: "UTF-8"))
  expected = %w[schemaVersion profileId projectId trackerId roleId]
  fail_with("configのshapeが不正です") unless value.is_a?(Hash) && value.keys.sort == expected.sort
  fail_with("schemaVersionは2である必要があります") unless value["schemaVersion"] == "2"
  fail_with("profileIdが不正です") unless value["profileId"].is_a?(String) && value["profileId"].match?(/\A[A-Za-z0-9][A-Za-z0-9._-]{0,127}\z/)
  %w[projectId trackerId roleId].each do |key|
    fail_with("#{key}が不正です") unless value[key].is_a?(Integer) && value[key].positive?
  end
  value
rescue JSON::ParserError
  fail_with("configをJSONとして読めません")
end

def assignments_match?(field, config)
  field.tracker_ids.sort == [config["trackerId"]] &&
    (!field.respond_to?(:role_ids) || field.role_ids.sort == [config["roleId"]]) &&
    (!field.respond_to?(:project_ids) || field.project_ids.sort == [config["projectId"]])
end

def field_contract_match?(field, config, format, searchable)
  assignments_match?(field, config) && field.field_format == format && !field.is_for_all &&
    (!field.respond_to?(:is_filter) || field.is_filter == searchable) &&
    (!field.respond_to?(:searchable) || field.searchable == searchable)
end

def plan_for(config)
  operations = []
  conflicts = []
  FIELD_SPECS.each do |key, spec|
    name, format, searchable, creatable = spec
    matches = IssueCustomField.where(name: name).to_a
    if matches.empty?
      if creatable && CREATION_KEYS.include?(key)
        operations << { "key" => key, "action" => "create", "detail" => "#{name}を作成" }
      else
        conflicts << { "key" => key, "detail" => "既存v1 field #{name}がありません。v2 applyでは作成しません" }
      end
    elsif matches.length > 1
      conflicts << { "key" => key, "detail" => "#{name}が重複しています", "ids" => matches.map(&:id).sort }
    elsif field_contract_match?(matches.first, config, format, searchable)
      operations << { "key" => key, "action" => "reuse", "id" => matches.first.id, "detail" => "#{name}を再利用" }
    else
      conflicts << { "key" => key, "id" => matches.first.id, "detail" => "#{name}の型・検索可否・割当が契約と一致しません" }
    end
  end
  body = {
    "schemaVersion" => "2",
    "provider" => "redmine",
    "profileId" => config["profileId"],
    "operations" => operations,
    "conflicts" => conflicts
  }
  body["planDigest"] = Digest::SHA256.hexdigest(JSON.generate(body))
  body
end

def create_v2_fields!(config, plan)
  IssueCustomField.transaction do
    plan.fetch("operations").select { |operation| operation["action"] == "create" }.each do |operation|
      key = operation.fetch("key")
      fail_with("v1 fieldは作成対象にできません: #{key}") unless CREATION_KEYS.include?(key)
      name, format, searchable, = FIELD_SPECS.fetch(key)
      fail_with("apply中に#{name}が追加されました。再planしてください") if IssueCustomField.where(name: name).exists?
      field = IssueCustomField.new(name: name)
      field.field_format = format
      field.is_for_all = false
      field.is_filter = searchable if field.respond_to?(:is_filter=)
      field.searchable = searchable if field.respond_to?(:searchable=)
      field.tracker_ids = [config["trackerId"]]
      field.role_ids = [config["roleId"]] if field.respond_to?(:role_ids=)
      field.project_ids = [config["projectId"]] if field.respond_to?(:project_ids=)
      field.save!
    end
    verification = plan_for(config)
    fail_with("apply後の全9 field検証に失敗しました") unless verification["conflicts"].empty? &&
      verification["operations"].all? { |operation| operation["action"] == "reuse" }
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

mode, config_path, output_directory, confirmation = ARGV
fail_with("usage: feedback_redmine_v2_custom_fields.rb <plan|apply> <config.json> <output-directory> [plan-digest]") unless
  %w[plan apply].include?(mode) && config_path && output_directory
config = load_config(config_path)
plan = plan_for(config)
write_private(File.join(output_directory, "feedback-v2-custom-fields-plan.json"), "#{JSON.pretty_generate(plan)}\n")

if mode == "plan"
  puts JSON.pretty_generate(plan)
  exit(plan["conflicts"].empty? ? 0 : 2)
end

fail_with("競合があるためapplyできません") unless plan["conflicts"].empty?
fail_with("plan digestの確認が必要です") unless confirmation == plan["planDigest"]
create_v2_fields!(config, plan)
verified = plan_for(config)
result = {
  "schemaVersion" => "2",
  "provider" => "redmine",
  "profileId" => config["profileId"],
  "appliedPlanDigest" => plan["planDigest"],
  "customFieldIds" => verified.fetch("operations").to_h { |operation| [operation.fetch("key"), operation.fetch("id")] }
}
write_private(File.join(output_directory, "feedback-v2-custom-fields-result.json"), "#{JSON.pretty_generate(result)}\n")
puts JSON.generate({ "status" => "applied", "planDigest" => plan["planDigest"] })
