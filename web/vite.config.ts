/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * Vite config for @www-rh/web.
 *
 * - `@www-rh/shared` resolves to the workspace package's TypeScript sources, so the web app
 *   always builds against the current shared code without a separate shared build step.
 * - Dev server proxies `/api` and `/ws` (WebSocket upgrade) to `VITE_RUNNER_URL` (directive W1),
 *   so the browser talks to the runner same-origin during development.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_');
  const runner = (env.VITE_RUNNER_URL ?? '').trim() || 'http://localhost:8787';

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@www-rh/shared': fileURLToPath(new URL('../packages/shared/src/index.ts', import.meta.url)),
      },
      dedupe: ['viem', 'react', 'react-dom'],
    },
    server: {
      port: 5173,
      proxy: {
        '/api': { target: runner, changeOrigin: true },
        '/ws': { target: runner, changeOrigin: true, ws: true },
      },
    },
    preview: {
      port: 4173,
    },
    build: {
      target: 'es2022',
      sourcemap: true,
      chunkSizeWarningLimit: 1500,
    },
    test: {
      include: ['src/**/*.test.ts'],
      environment: 'node',
    },
  };
});
