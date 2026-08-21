require "json"

issue = Issue.find(Integer(ARGV.fetch(0)))
original_format = Setting.text_formatting
controller = ApplicationController.new
controller.set_request!(
  ActionDispatch::Request.new(Rack::MockRequest.env_for("http://redmine.example.test/"))
)
controller.set_response!(ActionDispatch::Response.new)
view = controller.view_context

begin
  rendered = %w[common_mark textile].to_h do |format|
    Setting.text_formatting = format
    html = view.textilizable(issue, :description)
    [format, html]
  end
ensure
  Setting.text_formatting = original_format
end

puts JSON.generate(rendered)
