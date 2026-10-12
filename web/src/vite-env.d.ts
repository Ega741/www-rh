/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CLUSTER?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_GATEWAY_URL?: string;
  readonly VITE_MINT_ADDRESS?: string;
}
