# Web ErfolgCRM v2 — статика React+Vite, раздаётся nginx.
#
# Сборка ИЗ КОРНЯ репозитория (context: .):
#   docker build -f apps/web/Dockerfile -t erfolgcrm-web .
#
# Vite-переменные (VITE_API_URL и т.п.) зашиваются в бандл НА СБОРКЕ:
#   docker build --build-arg VITE_API_URL=https://crm.erfolg-md.ru ...

FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/

# Полная установка (без --filter): при shamefully-hoist=false фильтрованная
# установка не размещает транзитивные типы (undici-types, csstype,
# vite-plugin-pwa/types) так, чтобы их находил `tsc` с moduleResolution=Bundler,
# и `tsc -b` падает с TS2792. Build-стадия промежуточная — финальный nginx-образ
# берёт только dist, поэтому лишние зависимости api на размер прод-образа не влияют.
RUN pnpm install --frozen-lockfile

COPY packages ./packages
COPY apps ./apps
# Корневые tsconfig нужны для `tsc -b`: apps/web/tsconfig.json extends
# ../../tsconfig.base.json. Без него tsc откатывается на classic-резолюцию
# (moduleResolution теряется) и падает с TS5083/TS2792/TS2688.
COPY tsconfig.base.json tsconfig.json ./

ARG VITE_API_URL
ARG VITE_TENANT_DOMAIN_SUFFIX
ARG VITE_DEFAULT_TENANT=erfolg
ENV VITE_API_URL=$VITE_API_URL \
    VITE_TENANT_DOMAIN_SUFFIX=$VITE_TENANT_DOMAIN_SUFFIX \
    VITE_DEFAULT_TENANT=$VITE_DEFAULT_TENANT

RUN pnpm --filter @erfolg/web build

FROM nginx:1.27-alpine
COPY infra/docker/web-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
