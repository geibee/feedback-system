FROM node:22.18.0-bookworm-slim AS build
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY contracts/feedback/package.json contracts/feedback/package.json
COPY packages/feedback-core/package.json packages/feedback-core/package.json
COPY packages/feedback-react/package.json packages/feedback-react/package.json
COPY packages/feedback-maplibre/package.json packages/feedback-maplibre/package.json
COPY packages/feedback-admin-react/package.json packages/feedback-admin-react/package.json
COPY packages/feedback-redmine-core/package.json packages/feedback-redmine-core/package.json
COPY packages/feedback-redmine-react/package.json packages/feedback-redmine-react/package.json
COPY packages/feedback-redmine-plugin/package.json packages/feedback-redmine-plugin/package.json
COPY packages/feedback-redmine-gateway/package.json packages/feedback-redmine-gateway/package.json
COPY apps/feedback-admin/package.json apps/feedback-admin/package.json
COPY apps/feedback-token-broker-reference/package.json apps/feedback-token-broker-reference/package.json
COPY apps/feedback-conformance-consumer/package.json apps/feedback-conformance-consumer/package.json
COPY apps/feedback-redmine-gateway-reference/package.json apps/feedback-redmine-gateway-reference/package.json
COPY apps/feedback-redmine-extension/package.json apps/feedback-redmine-extension/package.json
COPY tests/redmine-conformance/package.json tests/redmine-conformance/package.json
COPY tests/redmine-browser-e2e/package.json tests/redmine-browser-e2e/package.json
COPY tests/fixtures/feedback-redmine-plugin-vanilla/package.json tests/fixtures/feedback-redmine-plugin-vanilla/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY contracts/feedback contracts/feedback
COPY packages/feedback-core packages/feedback-core
COPY packages/feedback-react packages/feedback-react
COPY packages/feedback-redmine-core packages/feedback-redmine-core
COPY packages/feedback-redmine-gateway packages/feedback-redmine-gateway
COPY apps/feedback-redmine-gateway-reference apps/feedback-redmine-gateway-reference
RUN npm --workspace @feedback/contracts run build \
  && npm --workspace @feedback/core run build \
  && npm --workspace @feedback/react run build \
  && npm --workspace @feedback/redmine-core run build \
  && npm --workspace @feedback/redmine-gateway run build \
  && npm --workspace @feedback/redmine-gateway-reference run build

FROM node:22.18.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/apps/feedback-redmine-gateway-reference/dist/server.js ./server.js
USER node
EXPOSE 8080
CMD ["node", "/app/server.js"]
