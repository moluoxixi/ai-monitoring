FROM node:24.19.0-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

COPY apps ./apps
RUN npm run build && npm prune --omit=dev

FROM node:24.19.0-bookworm-slim AS runtime

ARG OPENCLAW_VERSION=2026.7.1-2
ARG QQBOT_PLUGIN_VERSION=2.0.1
ARG WEIXIN_PLUGIN_VERSION=2.4.6

ENV NODE_ENV=production \
    AIMONITOR_HOST=0.0.0.0 \
    AIMONITOR_PORT=8787 \
    AI_MONITOR_QQBOT_PLUGIN_VERSION=${QQBOT_PLUGIN_VERSION} \
    AI_MONITOR_WEIXIN_PLUGIN_VERSION=${WEIXIN_PLUGIN_VERSION} \
    OPENCLAW_STATE_DIR=/home/node/.openclaw \
    PATH=/opt/apprise/bin:$PATH

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl python3 python3-venv \
    && python3 -m venv /opt/apprise \
    && /opt/apprise/bin/pip install --no-cache-dir "apprise==1.12.0" \
    && npm install --global "openclaw@${OPENCLAW_VERSION}" \
    && rm -rf /var/lib/apt/lists/* /root/.cache /root/.npm

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY scripts/ensure-openclaw-plugins.mjs scripts/openclaw-emit-notification.mjs scripts/patch-openclaw-weixin.mjs scripts/docker-entrypoint.sh ./scripts/
COPY plugins/openclaw-ai-monitor-replies ./plugins/openclaw-ai-monitor-replies

RUN mkdir -p /app/data /home/node/.openclaw \
    && chown -R node:node /app /home/node/.openclaw \
    && chmod +x /app/scripts/docker-entrypoint.sh

USER node
RUN node /app/scripts/ensure-openclaw-plugins.mjs \
    && node /app/scripts/patch-openclaw-weixin.mjs

EXPOSE 8787 18789

HEALTHCHECK CMD curl --fail --silent http://127.0.0.1:8787/api/health > /dev/null || exit 1

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["node", "apps/server/dist/main.js"]
