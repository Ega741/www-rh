/**
 * The deployment the pages burn against: `GET /api/config` (mint, decimals, symbol, token
 * program, memo program, operator, minimum credit) reconciled with the committed deployment of
 * this build (`resolveDeployment` + `VITE_MINT_ADDRESS`). A disagreement on the mint or the
 * cluster disables the flows and says why (`lib/config.ts#reconcileDeployment`).
 */
import { config } from '../config.js';
import { reconcileDeployment, type DeploymentView } from '../lib/config.js';
import { useGatewayConfig } from '../queries.js';

/** What {@link useDeployment} returns. */
export interface DeploymentInfo extends DeploymentView {
  /** Still waiting for `/api/config` and nothing committed to fall back on. */
  loading: boolean;
  /** `/api/config` failed and no committed deployment exists, or the build and the gateway disagree. */
  error: string | undefined;
  /** `MIN_CREDIT_USD` in µUSD, once `/api/config` answered. */
  minCreditMicro: bigint | undefined;
  /** The gateway's public RPC suggestion (informational; the wallet uses the build's RPC). */
  gatewayRpcUrl: string | undefined;
}

/** Resolves the mint and token facts. */
export function useDeployment(): DeploymentInfo {
  const gw = useGatewayConfig();
  const view = reconcileDeployment(config.deployment, gw.data);
  const loading = gw.isPending && view.mint === undefined;
  const error = view.mismatch ?? (!loading && view.mint === undefined ? (gw.isError ? 'Gateway configuration is unavailable' : 'The mint is not configured (set VITE_MINT_ADDRESS or MINT_ADDRESS on the gateway)') : undefined);
  return {
    ...view,
    loading,
    error,
    minCreditMicro: gw.data?.minCreditMicro,
    gatewayRpcUrl: gw.data?.rpcUrl,
  };
}
