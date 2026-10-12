/**
 * Sign-In-With-Solana message construction for `POST /api/auth/verify` (SPEC §5.3), on top of
 * `@beagle/shared/siws`. The gateway checks `domain == host(PUBLIC_URL)` and `uri` origin ==
 * `PUBLIC_URL` origin, so both come from the public gateway URL (`VITE_GATEWAY_URL`, or the page
 * origin when the gateway is same-origin); `chainId` is the CAIP-2 id of the build's cluster.
 */
import { clusterCaip, type Cluster } from '@beagle/shared/clusters';
import { SIWS_DEFAULT_STATEMENT, SIWS_VERSION, createSiwsMessage, siwsExpiration, siwsTimestamp } from '@beagle/shared/siws';
import { encodeBase58 } from '@beagle/shared/solana';

/** Inputs of {@link buildSiwsMessage}. */
export interface SiwsInput {
  /** The wallet's public key (base58). */
  address: string;
  cluster: Cluster;
  nonce: string;
  /** Public gateway URL (`''` → `pageOrigin`). */
  gatewayUrl: string;
  /** `window.location.origin`. */
  pageOrigin: string;
  now: Date;
}

/** The URL whose `host` is the SIWS domain and whose origin is the SIWS uri. */
export function siwsAuthority(gatewayUrl: string, pageOrigin: string): URL {
  return new URL(gatewayUrl.trim() !== '' ? gatewayUrl : pageOrigin);
}

/** Builds the wallet-standard sign-in text to sign (`expirationTime = issuedAt + 10 min`). */
export function buildSiwsMessage(input: SiwsInput): string {
  const authority = siwsAuthority(input.gatewayUrl, input.pageOrigin);
  const issuedAt = siwsTimestamp(input.now);
  return createSiwsMessage({
    domain: authority.host,
    address: input.address,
    statement: SIWS_DEFAULT_STATEMENT,
    uri: `${authority.origin}/`,
    version: SIWS_VERSION,
    chainId: clusterCaip(input.cluster),
    nonce: input.nonce,
    issuedAt,
    expirationTime: siwsExpiration(issuedAt),
  });
}

/**
 * The `signIn` input for wallets exposing the wallet-standard feature (used only when the wallet
 * has no `signMessage`): the same fields, the wallet renders the text itself.
 */
export function siwsSignInInput(input: SiwsInput): {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: string;
  chainId: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
} {
  const authority = siwsAuthority(input.gatewayUrl, input.pageOrigin);
  const issuedAt = siwsTimestamp(input.now);
  return {
    domain: authority.host,
    address: input.address,
    statement: SIWS_DEFAULT_STATEMENT,
    uri: `${authority.origin}/`,
    version: SIWS_VERSION,
    chainId: clusterCaip(input.cluster),
    nonce: input.nonce,
    issuedAt,
    expirationTime: siwsExpiration(issuedAt),
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** UTF-8 bytes of the message (what `signMessage` signs and the gateway verifies). */
export function messageBytes(message: string): Uint8Array {
  return encoder.encode(message);
}

/** Text of the bytes a wallet's `signIn` reports as `signedMessage`. */
export function messageText(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Base58 of a detached signature, the form `POST /api/auth/verify` takes. */
export function encodeSignature(signature: Uint8Array): string {
  return encodeBase58(signature);
}
