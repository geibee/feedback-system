FROM --platform=$BUILDPLATFORM docker.io/library/node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e AS build
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY contracts/feedback/package.json contracts/feedback/package.json
COPY packages/feedback-core/package.json packages/feedback-core/package.json
COPY packages/feedback-dom-capture/package.json packages/feedback-dom-capture/package.json
COPY packages/feedback-react/package.json packages/feedback-react/package.json
COPY packages/feedback-maplibre/package.json packages/feedback-maplibre/package.json
COPY packages/feedback-admin-react/package.json packages/feedback-admin-react/package.json
COPY packages/feedback-redmine-core/package.json packages/feedback-redmine-core/package.json
COPY packages/feedback-redmine-react/package.json packages/feedback-redmine-react/package.json
COPY packages/feedback-redmine-plugin/package.json packages/feedback-redmine-plugin/package.json
COPY packages/feedback-redmine-gateway/package.json packages/feedback-redmine-gateway/package.json
COPY packages/feedback-redmine-ops/package.json packages/feedback-redmine-ops/package.json
COPY apps/feedback-admin/package.json apps/feedback-admin/package.json
COPY apps/feedback-token-broker-reference/package.json apps/feedback-token-broker-reference/package.json
COPY apps/feedback-conformance-consumer/package.json apps/feedback-conformance-consumer/package.json
COPY apps/feedback-redmine-gateway-reference/package.json apps/feedback-redmine-gateway-reference/package.json
COPY apps/feedback-redmine-demo/package.json apps/feedback-redmine-demo/package.json
COPY tests/redmine-conformance/package.json tests/redmine-conformance/package.json
COPY tests/redmine-browser-e2e/package.json tests/redmine-browser-e2e/package.json
COPY tests/fixtures/feedback-redmine-plugin-vanilla/package.json tests/fixtures/feedback-redmine-plugin-vanilla/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY contracts/feedback contracts/feedback
COPY packages/feedback-core packages/feedback-core
COPY packages/feedback-redmine-core packages/feedback-redmine-core
COPY packages/feedback-redmine-gateway packages/feedback-redmine-gateway
COPY apps/feedback-redmine-gateway-reference apps/feedback-redmine-gateway-reference
RUN npm --workspace @geibee/feedback-contracts run build \
  && npm --workspace @geibee/feedback-core run build \
  && npm --workspace @geibee/feedback-redmine-core run build \
  && npm --workspace @geibee/feedback-redmine-gateway run build \
  && npm --workspace @geibee/redmine-gateway-reference run build

FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:939d6f1671529d230f50b563578e9b5d206af58f038b10ebd7e1233023d4e167
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Feedback Redmine gateway" \
  org.opencontainers.image.version="$VERSION" \
  org.opencontainers.image.revision="$REVISION" \
  org.opencontainers.image.source="https://github.com/geibee/feedback-system"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/apps/feedback-redmine-gateway-reference/dist/server.js ./server.js
USER nonroot
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:8080/internal/feedback-redmine/v1/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["/app/server.js"]
