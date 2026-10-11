# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
ARG VITE_CHAIN_ID=4663
ARG VITE_GATEWAY_URL=
ARG VITE_CREDIT_DESK_ADDRESS=0x0000000000000000000000000000000000000000
ARG VITE_RPC_URL=
ARG VITE_WALLETCONNECT_PROJECT_ID=
ARG VITE_MULTICALL=
ENV VITE_CHAIN_ID=$VITE_CHAIN_ID VITE_GATEWAY_URL=$VITE_GATEWAY_URL VITE_CREDIT_DESK_ADDRESS=$VITE_CREDIT_DESK_ADDRESS \
    VITE_RPC_URL=$VITE_RPC_URL VITE_WALLETCONNECT_PROJECT_ID=$VITE_WALLETCONNECT_PROJECT_ID VITE_MULTICALL=$VITE_MULTICALL
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
