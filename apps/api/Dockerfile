# API ErfolgCRM v2 — образ для docker-compose.prod.yml (staging / восстановление).
#
# Особенность монорепо: workspace-пакеты (@erfolg/db, @erfolg/shared) экспортируют
# TypeScript-источники (package.json → "exports": "./src/index.ts"), поэтому
# скомпилированный dist API не может их импортировать через node. Запускаем
# через tsx — тот же код-путь, что в dev (обкатан 400+ тестами), NODE_ENV=production.
#
# Сборка ИЗ КОРНЯ репозитория (context: .):
#   docker build -f apps/api/Dockerfile -t erfolgcrm-api .

FROM node:24-alpine

# argon2 ставится из prebuilt-бинарей (musl). Если на новой версии prebuild
# отсутствует и сборка падает — раскомментировать toolchain:
# RUN apk add --no-cache python3 make g++

RUN corepack enable
WORKDIR /app

# Сначала только манифесты — слой с зависимостями кэшируется между сборками.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/

# --filter @erfolg/api... = api + все его workspace-зависимости.
RUN pnpm install --frozen-lockfile --filter "@erfolg/api..."

COPY packages ./packages
COPY apps/api ./apps/api

ENV NODE_ENV=production
EXPOSE 3030

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3030/health || exit 1

CMD ["pnpm", "--filter", "@erfolg/api", "exec", "tsx", "src/index.ts"]
