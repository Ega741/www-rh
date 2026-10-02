/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_LAUNCHPAD_ADDRESS?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_RUNNER_URL?: string;
  readonly VITE_RUNNER_WS?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  readonly VITE_MULTICALL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
