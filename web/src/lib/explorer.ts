/**
 * Explorer links and short display forms of Solana identifiers. Thin wrappers over
 * `@beagle/shared/clusters` (localnet links carry the RPC the explorer should query).
 */
import { explorerAddressUrl, explorerTokenUrl, explorerTxUrl, type Cluster } from '@beagle/shared/clusters';
import { shortAddress as shortBase58 } from '@beagle/shared/solana';

/** `Abcd…wxyz`. `chars` is the number of characters kept on each side. */
export function shortAddress(address: string, chars = 4): string {
  return shortBase58(address, chars);
}

/** `5VERv8NM…9ZWz` for transaction signatures. */
export function shortSignature(signature: string, head = 8, tail = 4): string {
  if (signature.length <= head + tail + 1) return signature;
  return `${signature.slice(0, head)}…${signature.slice(-tail)}`;
}

/** `0x12345678…abcd` for 32-byte hex hashes (receipt hashes). */
export function shortHash(hash: string, head = 8, tail = 4): string {
  if (hash.length <= 2 + head + tail) return hash;
  return `${hash.slice(0, 2 + head)}…${hash.slice(-tail)}`;
}

/** `req_c13ba5d4…` for request ids (`req_` + UUID) in tables; the full id goes in the link target and title. */
export function shortRequestId(id: string, head = 12): string {
  return id.length <= head + 1 ? id : `${id.slice(0, head)}…`;
}

/** Explorer URL of a transaction; `rpcUrl` points a localnet link at the right validator. */
export function txLink(cluster: Cluster, signature: string, rpcUrl?: string): string {
  return explorerTxUrl(cluster, signature, rpcUrl === undefined ? {} : { rpcUrl });
}

/** Explorer URL of an account. */
export function addressLink(cluster: Cluster, address: string, rpcUrl?: string): string {
  return explorerAddressUrl(cluster, address, rpcUrl === undefined ? {} : { rpcUrl });
}

/** Explorer URL of a mint. */
export function tokenLink(cluster: Cluster, mint: string, rpcUrl?: string): string {
  return explorerTokenUrl(cluster, mint, rpcUrl === undefined ? {} : { rpcUrl });
}

/** `true` when two base58 keys name the same account (base58 is case-sensitive: exact match). */
export function sameAddress(a: string | undefined | null, b: string | undefined | null): boolean {
  return typeof a === 'string' && typeof b === 'string' && a !== '' && a === b;
}
