# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/mcp/package.json packages/mcp/
COPY gateway/package.json gateway/
RUN pnpm install --frozen-lockfile --filter @beagle/shared --filter @beagle/mcp --filter @beagle/gateway
COPY packages/shared packages/shared
COPY packages/mcp packages/mcp
COPY gateway gateway
RUN pnpm --filter @beagle/shared build && pnpm --filter @beagle/mcp build && pnpm --filter @beagle/gateway build
RUN pnpm --filter @beagle/gateway --prod deploy --legacy /out

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "dist/main.js"]
