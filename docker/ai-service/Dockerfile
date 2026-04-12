FROM oven/bun:1 AS builder
WORKDIR /app

# Copy all workspace package.json files so bun can resolve monorepo deps
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY apps/cloud/package.json apps/cloud/
COPY apps/desktop/package.json apps/desktop/
COPY apps/mcp-server/package.json apps/mcp-server/
COPY apps/ai-service/package.json apps/ai-service/

RUN bun install --ignore-scripts

COPY apps/ai-service/ apps/ai-service/
COPY packages/core/ packages/core/

FROM oven/bun:1-slim
WORKDIR /app

COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/apps/ai-service apps/ai-service
COPY --from=builder /app/packages/core packages/core

CMD ["bun", "run", "apps/ai-service/src/index.ts"]
