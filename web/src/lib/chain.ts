/**
 * Explorer links for the target chain (Blockscout layout, from the chain object in
 * `@www-rh/shared`) and the EIP-3085 parameters for "Add Robinhood Chain".
 *
 * @module lib/chain
 */
import { explorerAddressUrl, explorerTokenUrl, explorerTxUrl, toAddEthereumChainParameter } from '@www-rh/shared';
import { TARGET_CHAIN } from '../config';

/** Explorer page of a transaction, or `null` when the chain has no explorer (anvil). */
export function txUrl(hash: string): string | null {
  return explorerTxUrl(TARGET_CHAIN, hash) ?? null;
}

/** Explorer page of an address, or `null`. */
export function addressUrl(address: string): string | null {
  return explorerAddressUrl(TARGET_CHAIN, address) ?? null;
}

/** Explorer token page (Blockscout `/token/<address>`), or `null`. */
export function tokenUrl(address: string): string | null {
  return explorerTokenUrl(TARGET_CHAIN, address) ?? null;
}

/** EIP-3085 `wallet_addEthereumChain` parameter for the target chain. */
export function addChainParameter(): ReturnType<typeof toAddEthereumChainParameter> {
  return toAddEthereumChainParameter(TARGET_CHAIN);
}
