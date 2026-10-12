/**
 * The deployment the pages burn against: `GET /api/config` (mint, decimals, symbol, token
 * program, memo program, operator, minimum credit) reconciled with the committed deployment of
 * this build (`resolveDeployment` + `VITE_MINT_ADDRESS`). A disagreement on the mint or the
 * cluster disables the flows and says why (`lib/config.ts#reconcileDeployment`); so does a failed
 * `/api/config` read, which the query keeps retrying (`lib/config.ts#deploymentStatus`).
 */
import { config } from '../config.js';
import { deploymentStatus, reconcileDeployment, type DeploymentStatus, type DeploymentView } from '../lib/config.js';
import { useGatewayConfig } from '../queries.js';

/** What {@link useDeployment} returns. */
export interface DeploymentInfo extends DeploymentView, DeploymentStatus {
  /** `MIN_CREDIT_USD` in µUSD, once `/api/config` answered. */
  minCreditMicro: bigint | undefined;
  /** The gateway's public RPC suggestion (informational; the wallet uses the build's RPC). */
  gatewayRpcUrl: string | undefined;
}

/** Resolves the mint and token facts. */
export function useDeployment(): DeploymentInfo {
  const gw = useGatewayConfig();
  const view = reconcileDeployment(config.deployment, gw.data);
  return {
    ...view,
    ...deploymentStatus(view, { hasData: gw.data !== undefined, pending: gw.isPending }),
    minCreditMicro: gw.data?.minCreditMicro,
    gatewayRpcUrl: gw.data?.rpcUrl,
  };
}
