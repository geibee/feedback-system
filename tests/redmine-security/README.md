# Redmine browser security fixture

`strict-csp-host.html` と `hostile-host.css` は、厳格なCSPと業務画面側の強いCSSがある状態でも
SPA同梱pluginのShadow DOM UIが動作することを確認するfixtureです。

`scripts/check-feedback-redmine-security.sh` からPlaywright smokeを起動し、次を検証します。

- inline/remote scriptや`unsafe-eval`なしで起動すること
- feature flagの有効化、無効化、再有効化で二重mountしないこと
- 業務画面の`button`等へのCSSがShadow DOM内へ侵入しないこと
- feature flag無効時にplugin chunk、DOM、gateway通信が発生しないこと
- browser配布物にsource mapやtest credentialがないこと
- reference gateway containerがnon-root/read-only/capabilityなしで起動すること
