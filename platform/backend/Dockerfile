# Build context: repository root (charts/store is bundled into the image).
# docker build -f platform/backend/Dockerfile .

FROM alpine/helm:3.18.6 AS helm

FROM node:22-alpine AS build
WORKDIR /app
COPY platform/backend/package.json platform/backend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY platform/backend/tsconfig.json ./
COPY platform/backend/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    CHARTS_DIR=/app/charts \
    AUDIT_DB_PATH=/data/audit.db \
    HELM_CACHE_HOME=/tmp/helm/cache \
    HELM_CONFIG_HOME=/tmp/helm/config \
    HELM_DATA_HOME=/tmp/helm/data
WORKDIR /app
RUN apk add --no-cache tini && mkdir -p /data && chown node:node /data
COPY --from=helm /usr/bin/helm /usr/local/bin/helm
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --chown=root:root platform/backend/package.json ./package.json
COPY --chown=root:root charts/store ./charts/store
USER node
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
