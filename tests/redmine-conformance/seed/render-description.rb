require "json"

issue = Issue.find(Integer(ARGV.fetch(0)))
rendered = %w[common_mark textile].to_h do |format|
  html = Redmine::WikiFormatting.to_html(
    format,
    issue.description,
    object: issue,
    attribute: :description
  )
  [format, html]
end

puts JSON.generate(rendered)
