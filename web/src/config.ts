/**
 * App configuration evaluated once from `import.meta.env` (SPEC §7). The pure loader lives in
 * `lib/config.ts`; this module only binds it to Vite's env.
 */
import { loadConfig, publicGatewayUrl as publicGatewayUrlOf, type AppConfig } from './lib/config.js';

export type { AppConfig } from './lib/config.js';

/** The resolved configuration of this build. */
export const config: AppConfig = loadConfig(
  {
    VITE_CLUSTER: import.meta.env.VITE_CLUSTER,
    VITE_RPC_URL: import.meta.env.VITE_RPC_URL,
    VITE_GATEWAY_URL: import.meta.env.VITE_GATEWAY_URL,
    VITE_MINT_ADDRESS: import.meta.env.VITE_MINT_ADDRESS,
  },
  { dev: import.meta.env.DEV },
);

/** The gateway URL to show users in docs and snippets (configured URL or this page's origin). */
export function publicGatewayUrl(): string {
  return publicGatewayUrlOf(config, typeof window === 'undefined' ? '' : window.location.origin);
}

/** `window.location.origin` (empty outside a browser). */
export function pageOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}
