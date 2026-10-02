# Web image: Vite build served by nginx (proxies /api and /ws to the runner service).
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY web web
ARG VITE_CHAIN_ID=46630
ARG VITE_LAUNCHPAD_ADDRESS=0x0000000000000000000000000000000000000000
ARG VITE_RUNNER_URL=
ARG VITE_RUNNER_WS=
ENV VITE_CHAIN_ID=$VITE_CHAIN_ID VITE_LAUNCHPAD_ADDRESS=$VITE_LAUNCHPAD_ADDRESS VITE_RUNNER_URL=$VITE_RUNNER_URL VITE_RUNNER_WS=$VITE_RUNNER_WS
RUN pnpm --filter @www-rh/shared build && pnpm --filter @www-rh/web build

FROM nginx:1.27-alpine
COPY docker/web.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
