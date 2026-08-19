# Redmine browser security fixture

`strict-csp-host.html` と `hostile-host.css` は、厳格なCSPと業務画面側の強いCSSがある状態でも
Chrome拡張機能のShadow DOM UIが動作することを確認するfixtureです。

`scripts/check-feedback-redmine-security.sh` からPlaywright smokeを起動し、次を検証します。

- inline/remote scriptや`unsafe-eval`なしで起動すること
- content scriptをprogrammatic registrationし、再読込しても二重mountしないこと
- 業務画面の`button`等へのCSSがShadow DOM内へ侵入しないこと
- API keyが`chrome.storage.session`だけに存在し、lock後に消えること
- 拡張ZIPが再現可能で、browser配布物にsource mapやtest credentialがないこと
- reference gateway containerがnon-root/read-only/capabilityなしで起動すること
