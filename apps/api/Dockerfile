# 说嘛 API 生产镜像
#
# 构建（仓库根目录）：docker build -t sema-api -f apps/api/Dockerfile .
# 运行：
#   docker run -p 8787:8787 \
#     -e ARK_API_KEY=... -e DATABASE_URL=postgres://... \
#     sema-api
#
# 注意：
# - 含 ffmpeg（移动端按住说话 AAC → PCM 转码依赖）
# - 首次启动需执行迁移：packages/db/drizzle/*.sql（drizzle-kit migrate 或手工 psql）

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH="$PNPM_HOME:$PATH"
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

FROM base AS build
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/ai-core/package.json packages/ai-core/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store

COPY packages/ packages/
COPY apps/api/ apps/api/
RUN pnpm --filter @sema/shared build && pnpm --filter @sema/ai-core build && pnpm --filter @sema/db build && pnpm --filter @sema/api build

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 8787
WORKDIR /app/apps/api
# 运行时用 tsx 直跑 TS（与 dev 一致；tsc build 仅作类型门禁）
CMD ["../../node_modules/.bin/tsx", "src/main.ts"]
