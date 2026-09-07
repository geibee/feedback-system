#!/usr/bin/env bash
# live runnerのService、公開client、production projectionまでを依存順にbuildする。
set -euo pipefail
cd "$(dirname "$0")/.."
for package in contracts envelope connector-sdk client gateway service connector-redmine connector-jira-cloud connector-backlog service-runtime; do
  npm --workspace "@geibee/feedback-$package" run build >&2
done
