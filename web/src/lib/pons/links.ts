/**
 * Post-graduation links of Pons mode (SPEC §9.5): "Trade on Pons", Uniswap and Blockscout.
 *
 * @module lib/pons/links
 */
/** Pons web app (SPEC §9.5 "Trade on Pons"). */
export const PONS_APP_URL = 'https://www.ponsfamily.com';

/** Robinhood Chain mainnet, the only chain with a Pons deployment and a Uniswap front-end. */
const MAINNET_CHAIN_ID = 4663;

/** "Trade on Pons" target. The Pons app has no documented per-token deep link, so this is its home page. */
export function ponsTradeUrl(): string {
  return PONS_APP_URL;
}

/**
 * Uniswap swap deep link for a graduated coin (native ETH → token), mainnet only; `null` elsewhere
 * (testnet/anvil have no Uniswap front-end).
 */
export function uniswapSwapUrl(token: string, chainId: number): string | null {
  if (chainId !== MAINNET_CHAIN_ID) return null;
  const q = new URLSearchParams({ inputCurrency: 'NATIVE', outputCurrency: token, chain: 'robinhood' });
  return `https://app.uniswap.org/swap?${q.toString()}`;
}
