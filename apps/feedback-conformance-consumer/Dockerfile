FROM --platform=$BUILDPLATFORM docker.io/library/node:22-alpine AS build

WORKDIR /repo
COPY package.json package-lock.json ./
COPY contracts/feedback/package.json contracts/feedback/package.json
COPY packages/feedback-core/package.json packages/feedback-core/package.json
COPY packages/feedback-dom-capture/package.json packages/feedback-dom-capture/package.json
COPY packages/feedback-react/package.json packages/feedback-react/package.json
COPY apps/feedback-conformance-consumer/package.json apps/feedback-conformance-consumer/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund --workspace @geibee/feedback-contracts --workspace @geibee/feedback-core \
    --workspace @geibee/feedback-dom-capture --workspace @geibee/react \
    --workspace @geibee/conformance-consumer --include-workspace-root=false
COPY contracts/feedback contracts/feedback
COPY packages/feedback-core packages/feedback-core
COPY packages/feedback-dom-capture packages/feedback-dom-capture
COPY packages/feedback-react packages/feedback-react
COPY apps/feedback-conformance-consumer apps/feedback-conformance-consumer
RUN npm --workspace @geibee/feedback-contracts run build \
    && npm --workspace @geibee/feedback-core run build \
    && npm --workspace @geibee/feedback-dom-capture run build \
    && npm --workspace @geibee/react run build \
    && npm --workspace @geibee/conformance-consumer run build

FROM docker.io/library/node:22-alpine
WORKDIR /app
COPY --from=build /repo/apps/feedback-conformance-consumer/dist ./dist
COPY --from=build /repo/apps/feedback-conformance-consumer/build/server ./server-dist
USER node
EXPOSE 8080
CMD ["node", "server-dist/server.js"]
