FROM --platform=$BUILDPLATFORM docker.io/library/node:22-alpine AS build

WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/feedback-token-broker-reference/package.json apps/feedback-token-broker-reference/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund --workspace @geibee/token-broker-reference --include-workspace-root=false
COPY apps/feedback-token-broker-reference apps/feedback-token-broker-reference
RUN npm --workspace @geibee/token-broker-reference run build

FROM docker.io/library/node:22-alpine
WORKDIR /app
COPY --from=build /repo/apps/feedback-token-broker-reference/dist ./dist
USER node
EXPOSE 8443
CMD ["node", "dist/server.js"]
