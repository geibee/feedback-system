issue = Issue.find(Integer(ARGV.fetch(0)))
user = User.find(Integer(ARGV.fetch(1)))

edited = Journal.new(journalized: issue, user: user, notes: "edited reply original")
edited.save!
edited.update_column(:notes, "edited reply current")

issue.init_journal(user, "   ")
issue.subject = "#{issue.subject} revised"
issue.save!
