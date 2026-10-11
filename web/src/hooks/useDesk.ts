/**
 * Where the contracts live: the desk from `resolveDeployment` (+ `VITE_CREDIT_DESK_ADDRESS`),
 * reconciled with the desk the gateway indexes (`GET /api/config.creditDesk`), the token from
 * `GET /api/config` (fallback: the committed deployment).
 */
import type { Address } from 'viem';
import { config } from '../config.js';
import { asAddress, reconcileDesk } from '../lib/config.js';
import { useGatewayConfig } from '../queries.js';

/** The credit token. */
export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
  nativeBurn: boolean;
}

/** What {@link useDesk} returns. */
export interface DeskInfo {
  desk: Address | undefined;
  token: TokenInfo | undefined;
  /** Still waiting for `/api/config` and nothing committed to fall back on. */
  loading: boolean;
  /** `/api/config` failed and no committed deployment exists, or the build and the gateway disagree on the desk. */
  error: string | undefined;
}

/** Resolves desk and token addresses. */
export function useDesk(): DeskInfo {
  const gw = useGatewayConfig();
  const dep = config.deployment;
  const { desk, mismatch } = reconcileDesk(dep.creditDesk, gw.data?.creditDesk);

  let token: TokenInfo | undefined;
  const t = gw.data?.token;
  const tokenAddr = asAddress(t?.address);
  if (t && tokenAddr !== undefined) token = { address: tokenAddr, symbol: t.symbol, decimals: t.decimals, nativeBurn: t.nativeBurn };
  else if (dep.token !== undefined) {
    token = { address: dep.token, symbol: dep.tokenSymbol ?? 'TOKEN', decimals: dep.tokenDecimals ?? 18, nativeBurn: dep.nativeBurn ?? true };
  }

  const loading = gw.isPending && (desk === undefined || token === undefined);
  const error = mismatch ?? (!loading && (desk === undefined || token === undefined) ? (gw.isError ? 'Gateway configuration is unavailable' : 'Credit desk or token address is not configured') : undefined);
  return { desk, token, loading, error };
}
