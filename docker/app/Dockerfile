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

COPY --chown=1000:1000 . .
RUN chown bun:bun /app
USER bun
RUN bun install --ignore-scripts
# Skip tsc (upstream type errors with current Bun) — Vite transpiles without strict checks.
RUN cd apps/desktop && bun run vite build

FROM nginx:alpine AS web
RUN apk add --no-cache curl
EXPOSE 5173/tcp
HEALTHCHECK --interval=1m30s --timeout=10s --start-period=30s --retries=3 CMD curl -fsS http://localhost:5173/ >/dev/null || exit 1
COPY --from=base /app/apps/desktop/dist /usr/share/nginx/html
COPY docker/app/nginx.conf /etc/nginx/conf.d/default.conf
