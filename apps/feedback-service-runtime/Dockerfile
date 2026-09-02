FROM --platform=$BUILDPLATFORM docker.io/library/node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e AS build
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY contracts/feedback/package.json contracts/feedback/package.json
COPY packages/feedback-core/package.json packages/feedback-core/package.json
COPY packages/feedback-client/package.json packages/feedback-client/package.json
COPY packages/feedback-connector-sdk/package.json packages/feedback-connector-sdk/package.json
COPY packages/feedback-envelope/package.json packages/feedback-envelope/package.json
COPY packages/feedback-gateway/package.json packages/feedback-gateway/package.json
COPY packages/feedback-controller/package.json packages/feedback-controller/package.json
COPY packages/feedback-web-component/package.json packages/feedback-web-component/package.json
COPY packages/feedback-react/package.json packages/feedback-react/package.json
COPY packages/feedback-connector-jira-cloud/package.json packages/feedback-connector-jira-cloud/package.json
COPY packages/feedback-connector-backlog/package.json packages/feedback-connector-backlog/package.json
COPY packages/feedback-connector-redmine/package.json packages/feedback-connector-redmine/package.json
COPY packages/feedback-dom-capture/package.json packages/feedback-dom-capture/package.json
COPY packages/feedback-react-ui/package.json packages/feedback-react-ui/package.json
COPY packages/feedback-maplibre/package.json packages/feedback-maplibre/package.json
COPY packages/feedback-redmine-core/package.json packages/feedback-redmine-core/package.json
COPY packages/feedback-redmine-react/package.json packages/feedback-redmine-react/package.json
COPY packages/feedback-redmine-plugin/package.json packages/feedback-redmine-plugin/package.json
COPY packages/feedback-redmine-gateway/package.json packages/feedback-redmine-gateway/package.json
COPY packages/feedback-redmine-ops/package.json packages/feedback-redmine-ops/package.json
COPY apps/feedback-redmine-gateway-reference/package.json apps/feedback-redmine-gateway-reference/package.json
COPY apps/feedback-redmine-demo/package.json apps/feedback-redmine-demo/package.json
COPY apps/feedback-service/package.json apps/feedback-service/package.json
COPY apps/feedback-service-runtime/package.json apps/feedback-service-runtime/package.json
COPY tests/redmine-conformance/package.json tests/redmine-conformance/package.json
COPY tests/redmine-browser-e2e/package.json tests/redmine-browser-e2e/package.json
COPY tests/feedback-provider-acceptance/package.json tests/feedback-provider-acceptance/package.json
COPY tests/fixtures/feedback-web-component-vanilla/package.json tests/fixtures/feedback-web-component-vanilla/package.json
COPY tests/fixtures/feedback-redmine-plugin-vanilla/package.json tests/fixtures/feedback-redmine-plugin-vanilla/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY contracts/feedback contracts/feedback
COPY packages/feedback-connector-sdk packages/feedback-connector-sdk
COPY packages/feedback-envelope packages/feedback-envelope
COPY packages/feedback-gateway packages/feedback-gateway
COPY packages/feedback-connector-jira-cloud packages/feedback-connector-jira-cloud
COPY packages/feedback-connector-backlog packages/feedback-connector-backlog
COPY packages/feedback-connector-redmine packages/feedback-connector-redmine
COPY apps/feedback-service apps/feedback-service
COPY apps/feedback-service-runtime apps/feedback-service-runtime
RUN npm --workspace @geibee/feedback-contracts run build \
 && npm --workspace @geibee/feedback-connector-sdk run build \
 && npm --workspace @geibee/feedback-envelope run build \
 && npm --workspace @geibee/feedback-gateway run build \
 && npm --workspace @geibee/feedback-connector-jira-cloud run build \
 && npm --workspace @geibee/feedback-connector-backlog run build \
 && npm --workspace @geibee/feedback-connector-redmine run build \
 && npm --workspace @geibee/feedback-service run build \
 && npm --workspace @geibee/feedback-service-runtime run build

FROM docker.io/library/node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e
ENV NODE_ENV=production
USER node
WORKDIR /app
COPY --from=build --chown=node:node /workspace/apps/feedback-service-runtime/package.json /app/apps/feedback-service-runtime/package.json
COPY --from=build --chown=node:node /workspace/apps/feedback-service-runtime/dist /app/apps/feedback-service-runtime/dist
COPY --from=build --chown=node:node /workspace/apps/feedback-service/package.json /app/node_modules/@geibee/feedback-service/package.json
COPY --from=build --chown=node:node /workspace/apps/feedback-service/dist /app/node_modules/@geibee/feedback-service/dist
COPY --from=build --chown=node:node /workspace/contracts/feedback/package.json /app/node_modules/@geibee/feedback-contracts/package.json
COPY --from=build --chown=node:node /workspace/contracts/feedback/dist /app/node_modules/@geibee/feedback-contracts/dist
COPY --from=build --chown=node:node /workspace/packages/feedback-connector-sdk/package.json /app/node_modules/@geibee/feedback-connector-sdk/package.json
COPY --from=build --chown=node:node /workspace/packages/feedback-connector-sdk/dist /app/node_modules/@geibee/feedback-connector-sdk/dist
COPY --from=build --chown=node:node /workspace/packages/feedback-envelope/package.json /app/node_modules/@geibee/feedback-envelope/package.json
COPY --from=build --chown=node:node /workspace/packages/feedback-envelope/dist /app/node_modules/@geibee/feedback-envelope/dist
COPY --from=build --chown=node:node /workspace/packages/feedback-gateway/package.json /app/node_modules/@geibee/feedback-gateway/package.json
COPY --from=build --chown=node:node /workspace/packages/feedback-gateway/dist /app/node_modules/@geibee/feedback-gateway/dist
COPY --from=build --chown=node:node /workspace/packages/feedback-connector-jira-cloud/package.json /app/node_modules/@geibee/feedback-connector-jira-cloud/package.json
COPY --from=build --chown=node:node /workspace/packages/feedback-connector-jira-cloud/dist /app/node_modules/@geibee/feedback-connector-jira-cloud/dist
COPY --from=build --chown=node:node /workspace/packages/feedback-connector-backlog/package.json /app/node_modules/@geibee/feedback-connector-backlog/package.json
COPY --from=build --chown=node:node /workspace/packages/feedback-connector-backlog/dist /app/node_modules/@geibee/feedback-connector-backlog/dist
COPY --from=build --chown=node:node /workspace/packages/feedback-connector-redmine/package.json /app/node_modules/@geibee/feedback-connector-redmine/package.json
COPY --from=build --chown=node:node /workspace/packages/feedback-connector-redmine/dist /app/node_modules/@geibee/feedback-connector-redmine/dist
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "apps/feedback-service-runtime/dist/main.js"]
