# Runner image: Playwright base (Chromium + Node 22) + pnpm workspace build.
FROM mcr.microsoft.com/playwright:v1.56.1-noble AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY runner/package.json runner/
RUN pnpm install --frozen-lockfile --prod=false
COPY packages/shared packages/shared
COPY runner runner
COPY scripts scripts
RUN pnpm --filter @www-rh/shared build && pnpm --filter @www-rh/runner build
RUN mkdir -p /app/runner/data
VOLUME ["/app/runner/data"]
EXPOSE 8787
WORKDIR /app/runner
CMD ["node", "dist/main.js"]
