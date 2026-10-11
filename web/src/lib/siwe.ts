/**
 * SIWE (EIP-4361) message construction for the gateway's `POST /api/auth/verify` (SPEC §5.3).
 * The gateway checks `domain == host(PUBLIC_URL)`, so the domain/uri come from the public gateway
 * URL (`VITE_GATEWAY_URL`, or the page origin when the gateway is same-origin).
 */
import type { Address } from 'viem';
import { createSiweMessage } from 'viem/siwe';

/** Statement shown in the wallet. */
export const SIWE_STATEMENT = 'Sign in to Beagle. This signature creates a session; it costs no gas and moves no tokens.';

/** Message validity window: matches the gateway's 10-minute nonce TTL. */
export const SIWE_TTL_MS = 10 * 60 * 1000;

/** Inputs of {@link buildSiweMessage}. */
export interface SiweInput {
  address: Address;
  chainId: number;
  nonce: string;
  /** Public gateway URL (`''` → `pageOrigin`). */
  gatewayUrl: string;
  /** `window.location.origin`. */
  pageOrigin: string;
  now: Date;
}

/** The URL whose `host` is the SIWE domain and whose origin is the SIWE uri. */
export function siweAuthority(gatewayUrl: string, pageOrigin: string): URL {
  return new URL(gatewayUrl.trim() !== '' ? gatewayUrl : pageOrigin);
}

/** Builds the EIP-4361 message text to sign. */
export function buildSiweMessage(input: SiweInput): string {
  const authority = siweAuthority(input.gatewayUrl, input.pageOrigin);
  return createSiweMessage({
    address: input.address,
    chainId: input.chainId,
    domain: authority.host,
    uri: `${authority.origin}/`,
    nonce: input.nonce,
    version: '1',
    statement: SIWE_STATEMENT,
    issuedAt: input.now,
    expirationTime: new Date(input.now.getTime() + SIWE_TTL_MS),
  });
}
