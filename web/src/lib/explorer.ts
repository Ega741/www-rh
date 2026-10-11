/**
 * Explorer links and short hex display. Thin wrappers over `@beagle/shared/chains` that tolerate
 * chains without an explorer (anvil) by returning `undefined`.
 */
import { getAddress, isAddress, type Chain } from 'viem';
import { explorerAddressUrl, explorerTxUrl, explorerBlockUrl } from '@beagle/shared/chains';

/** EIP-55 checksummed form of `addr` when it is an address, else the input unchanged. */
export function checksum(addr: string): string {
  return isAddress(addr, { strict: false }) ? getAddress(addr) : addr;
}

/** `0x1234…abcd` (checksummed). `chars` is the number of hex digits kept on each side. */
export function shortAddress(addr: string, chars = 4): string {
  const a = checksum(addr);
  if (a.length <= 2 + chars * 2) return a;
  return `${a.slice(0, 2 + chars)}…${a.slice(-chars)}`;
}

/** `0x12345678…abcd` for transaction / receipt hashes. */
export function shortHash(hash: string, head = 8, tail = 4): string {
  if (hash.length <= 2 + head + tail) return hash;
  return `${hash.slice(0, 2 + head)}…${hash.slice(-tail)}`;
}

/** Explorer URL of a transaction, or `undefined` when the chain has no explorer. */
export function txLink(chain: Chain, hash: string): string | undefined {
  return explorerTxUrl(chain, hash);
}

/** Explorer URL of an address, or `undefined` when the chain has no explorer. */
export function addressLink(chain: Chain, addr: string): string | undefined {
  return explorerAddressUrl(chain, checksum(addr));
}

/** Explorer URL of a block, or `undefined` when the chain has no explorer. */
export function blockLink(chain: Chain, block: number | bigint): string | undefined {
  return explorerBlockUrl(chain, block);
}

/** `true` when two addresses are the same account (case-insensitive). */
export function sameAddress(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}
