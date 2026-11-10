FROM oven/bun:1.3.3-alpine@sha256:d2bc1fbc3afcd3d70afc2bb2544235bf559caae2a3084e9abed126e233797511 AS base
WORKDIR /app

FROM base AS deps
COPY --chown=1000:1000 . .
RUN chown bun:bun /app
USER bun
# --ignore-scripts: the only native postinstall in the workspace is
# better-sqlite3 (apps/mcp-server, not run in this image), and its node-gyp
# header download hangs forever inside the Colima VM network. Skipping
# scripts also drops the python3/make/g++ toolchain from the build.
RUN bun install --production --ignore-scripts

FROM base AS cloud
RUN apk add --no-cache curl
ENV MINDWTR_CLOUD_DATA_DIR=/app/cloud_data
COPY --from=deps --chown=bun:bun /app /app
RUN mkdir -p /app/cloud_data && chown bun:bun /app/cloud_data
USER bun

EXPOSE 8787/tcp
HEALTHCHECK --interval=1m30s --timeout=10s --start-period=30s --retries=3 CMD curl -fsS http://localhost:8787/health >/dev/null || exit 1
ENTRYPOINT ["bun", "run", "--filter", "mindwtr-cloud", "start", "--", "--host", "0.0.0.0", "--port", "8787"]
