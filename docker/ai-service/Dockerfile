FROM oven/bun:1 AS builder
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/ai-service/package.json apps/ai-service/
RUN bun install --frozen-lockfile

COPY apps/ai-service/ apps/ai-service/

FROM oven/bun:1-slim
WORKDIR /app

COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/apps/ai-service apps/ai-service

CMD ["bun", "run", "apps/ai-service/src/index.ts"]
