FROM oven/bun:1.3.3-alpine AS base
WORKDIR /app

RUN apk add --no-cache python3 make g++
ENV CXXFLAGS="-std=c++20"
ENV npm_config_cxxstd=gnu++20
ENV npm_config_target="22.21.1"
ENV npm_config_disturl="https://nodejs.org/dist"

# Build-time URL + token for the AI Service (Proposals / suggestions endpoint).
# Both are baked into the Vite bundle. Token is therefore *not secret* — anyone
# who serves the bundle can read it. For a single-user personal deploy this is
# acceptable; rotate when you change the public deployment.
ARG VITE_AI_SERVICE_URL=""
ARG VITE_AI_SERVICE_TOKEN=""
ENV VITE_AI_SERVICE_URL=$VITE_AI_SERVICE_URL
ENV VITE_AI_SERVICE_TOKEN=$VITE_AI_SERVICE_TOKEN

# Cloud sync target + token baked for prod origin (gtd.kurdy.uk → api.kurdy.uk).
# The web app picks localhost:8787 automatically when served from localhost,
# so only the non-localhost (prod) URL needs baking. Token is not a real
# secret here — see apps/desktop/src/lib/cloud-target.ts.
ARG VITE_CLOUD_URL=""
ARG VITE_CLOUD_TOKEN=""
ENV VITE_CLOUD_URL=$VITE_CLOUD_URL
ENV VITE_CLOUD_TOKEN=$VITE_CLOUD_TOKEN

# Dependencies first, sources after: an edit to app code then reuses the
# installed node_modules layer instead of reinstalling everything.
# packages/core goes in whole because the desktop app depends on it as a
# `file:` package, which bun copies into node_modules at install time.
COPY --chown=1000:1000 package.json bun.lock ./
COPY --chown=1000:1000 apps/agent-runner/package.json apps/agent-runner/
COPY --chown=1000:1000 apps/ai-service/package.json apps/ai-service/
COPY --chown=1000:1000 apps/capture-agent/package.json apps/capture-agent/
COPY --chown=1000:1000 apps/cloud/package.json apps/cloud/
COPY --chown=1000:1000 apps/desktop/package.json apps/desktop/
COPY --chown=1000:1000 apps/mcp-server/package.json apps/mcp-server/
COPY --chown=1000:1000 apps/mobile/package.json apps/mobile/
COPY --chown=1000:1000 packages/core/ packages/core/
RUN chown -R bun:bun /app
USER bun
RUN bun install --ignore-scripts

COPY --chown=1000:1000 . .
# Skip tsc (upstream type errors with current Bun) — Vite transpiles without strict checks.
RUN cd apps/desktop && bun run vite build

FROM nginx:alpine AS web
RUN apk add --no-cache curl
EXPOSE 5173/tcp
HEALTHCHECK --interval=1m30s --timeout=10s --start-period=30s --retries=3 CMD curl -fsS http://localhost:5173/ >/dev/null || exit 1
COPY --from=base /app/apps/desktop/dist /usr/share/nginx/html
COPY docker/app/nginx.conf /etc/nginx/conf.d/default.conf
