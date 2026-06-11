# Web ErfolgCRM v2 — статика React+Vite, раздаётся nginx.
#
# Сборка ИЗ КОРНЯ репозитория (context: .):
#   docker build -f apps/web/Dockerfile -t erfolgcrm-web .
#
# Vite-переменные (VITE_API_URL и т.п.) зашиваются в бандл НА СБОРКЕ:
#   docker build --build-arg VITE_API_URL=https://crm.erfolg-md.ru ...

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/

RUN pnpm install --frozen-lockfile --filter "@erfolg/web..."

COPY packages ./packages
COPY apps ./apps

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
