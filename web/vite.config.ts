import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** Repository root: the single `.env` shared by the gateway, the web build and the contract scripts. */
const envDir = new URL('..', import.meta.url).pathname;

/** Gateway paths proxied in development (mirrors `docker/nginx.conf`). */
const PROXIED = ['/api', '/v1', '/mcp', '/healthz'] as const;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, 'VITE_');
  const gateway = env['VITE_GATEWAY_URL']?.trim() || 'http://localhost:8787';
  const proxy = Object.fromEntries(
    PROXIED.map((path) => [path, { target: gateway, changeOrigin: true, ws: false }] as const),
  );
  return {
    envDir,
    plugins: [react(), tailwindcss()],
    server: { port: 5173, strictPort: false, proxy },
    preview: { port: 5173, proxy },
    build: {
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: 1500,
    },
  };
});
