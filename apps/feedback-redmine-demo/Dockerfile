FROM --platform=$BUILDPLATFORM docker.io/library/node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e AS build
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY contracts/feedback/package.json contracts/feedback/package.json
COPY packages/feedback-core/package.json packages/feedback-core/package.json
COPY packages/feedback-dom-capture/package.json packages/feedback-dom-capture/package.json
COPY packages/feedback-react-ui/package.json packages/feedback-react-ui/package.json
COPY packages/feedback-react/package.json packages/feedback-react/package.json
COPY packages/feedback-maplibre/package.json packages/feedback-maplibre/package.json
COPY packages/feedback-admin-react/package.json packages/feedback-admin-react/package.json
COPY packages/feedback-redmine-core/package.json packages/feedback-redmine-core/package.json
COPY packages/feedback-redmine-react/package.json packages/feedback-redmine-react/package.json
COPY packages/feedback-redmine-plugin/package.json packages/feedback-redmine-plugin/package.json
COPY packages/feedback-redmine-gateway/package.json packages/feedback-redmine-gateway/package.json
COPY packages/feedback-redmine-ops/package.json packages/feedback-redmine-ops/package.json
COPY apps/feedback-redmine-gateway-reference/package.json apps/feedback-redmine-gateway-reference/package.json
COPY apps/feedback-redmine-demo/package.json apps/feedback-redmine-demo/package.json
COPY apps/feedback-admin/package.json apps/feedback-admin/package.json
COPY apps/feedback-token-broker-reference/package.json apps/feedback-token-broker-reference/package.json
COPY apps/feedback-conformance-consumer/package.json apps/feedback-conformance-consumer/package.json
COPY tests/redmine-conformance/package.json tests/redmine-conformance/package.json
COPY tests/redmine-browser-e2e/package.json tests/redmine-browser-e2e/package.json
COPY tests/fixtures/feedback-redmine-plugin-vanilla/package.json tests/fixtures/feedback-redmine-plugin-vanilla/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY contracts/feedback contracts/feedback
COPY packages/feedback-core packages/feedback-core
COPY packages/feedback-dom-capture packages/feedback-dom-capture
COPY packages/feedback-react-ui packages/feedback-react-ui
COPY packages/feedback-redmine-core packages/feedback-redmine-core
COPY packages/feedback-redmine-react packages/feedback-redmine-react
COPY packages/feedback-redmine-plugin packages/feedback-redmine-plugin
COPY apps/feedback-redmine-demo apps/feedback-redmine-demo
RUN npm --workspace @geibee/contracts run build \
  && npm --workspace @geibee/core run build \
  && npm --workspace @geibee/dom-capture run build \
  && npm --workspace @geibee/react-ui run build \
  && npm --workspace @geibee/redmine-core run build \
  && npm --workspace @geibee/redmine-react run build \
  && npm --workspace @geibee/redmine-plugin run build \
  && npm --workspace @geibee/redmine-demo run build

FROM docker.io/nginxinc/nginx-unprivileged:1.31.4-alpine@sha256:c3fed6436b61d2bf2201ec032c35c000871f7ed062dea5d586bc6bf4d0fdd140
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Feedback Redmine local demo" \
  org.opencontainers.image.version="$VERSION" \
  org.opencontainers.image.revision="$REVISION" \
  org.opencontainers.image.source="https://github.com/geibee/feedback-system"
COPY --from=build /workspace/apps/feedback-redmine-demo/dist /usr/share/nginx/html
COPY apps/feedback-redmine-demo/nginx.conf /etc/nginx/nginx.conf
USER 101
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/health"]
