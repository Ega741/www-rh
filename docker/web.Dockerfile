# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
# Vite build-time env (docs/SPEC.md §7): cluster, optional RPC override, gateway base URL (empty = same origin behind
# nginx) and an optional mint override of the committed deployment. Everything else comes from GET /api/config.
ARG VITE_CLUSTER=mainnet-beta
ARG VITE_GATEWAY_URL=
ARG VITE_RPC_URL=
ARG VITE_MINT_ADDRESS=
ENV VITE_CLUSTER=$VITE_CLUSTER VITE_GATEWAY_URL=$VITE_GATEWAY_URL VITE_RPC_URL=$VITE_RPC_URL VITE_MINT_ADDRESS=$VITE_MINT_ADDRESS
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --filter @beagle/shared --filter @beagle/web
COPY packages/shared packages/shared
COPY web web
RUN pnpm --filter @beagle/shared build && pnpm --filter @beagle/web build

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
