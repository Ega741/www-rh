/**
 * Sign-In-With-Ethereum (SPEC §5.3): nonces (10 min, single use), message parsing and signature
 * verification. The verifier is injectable: the default checks an EOA signature offline with viem's
 * `verifyMessage` and falls back to `verifySiweMessage` against the chain's public client
 * (ERC-1271 / ERC-6492 contract wallets) when one is available.
 *
 * @module auth/siwe
 */
import { isSupportedChainId } from '@beagle/shared/chains';
import { verifyMessage, type Address, type Hex, type PublicClient } from 'viem';
import { generateSiweNonce, parseSiweMessage, validateSiweMessage, verifySiweMessage, type SiweMessage } from 'viem/siwe';
import type { NonceRepo } from '../db/repos.js';

/** Nonce lifetime. */
export const SIWE_NONCE_TTL_MS = 10 * 60 * 1000;

/** Verifies that `signature` signs `message` for `parsed.address`. */
export type SiweVerifier = (input: { message: string; signature: Hex; parsed: SiweMessage }) => Promise<boolean>;

/** Result of {@link SiweService.verify}. */
export type SiweVerifyResult = { ok: true; address: Address; chainId: number } | { ok: false; code: 'invalid_message' | 'bad_domain' | 'bad_nonce' | 'bad_chain' | 'bad_signature' | 'expired'; message: string };

/** Options of {@link SiweService}. */
export interface SiweServiceOptions {
  /** Expected `domain` (host of `PUBLIC_URL`). */
  domain: string;
  verifier?: SiweVerifier;
  /** Public client factory per chain id for contract-wallet verification (optional). */
  publicClientFor?: (chainId: number) => PublicClient | undefined;
  now?: () => number;
}

/** The default verifier: offline EOA check, then on-chain universal verification when possible. */
export function defaultSiweVerifier(publicClientFor?: (chainId: number) => PublicClient | undefined): SiweVerifier {
  return async ({ message, signature, parsed }) => {
    try {
      if (await verifyMessage({ address: parsed.address, message, signature })) return true;
    } catch {
      // fall through to the on-chain path
    }
    const client = publicClientFor?.(parsed.chainId);
    if (client === undefined) return false;
    try {
      return await verifySiweMessage(client, { message, signature });
    } catch {
      return false;
    }
  };
}

/** Nonce issuance and SIWE verification. */
export class SiweService {
  private readonly verifier: SiweVerifier;
  private readonly now: () => number;

  constructor(
    private readonly nonces: NonceRepo,
    private readonly options: SiweServiceOptions,
  ) {
    this.verifier = options.verifier ?? defaultSiweVerifier(options.publicClientFor);
    this.now = options.now ?? (() => Date.now());
  }

  /** Issues a nonce valid for {@link SIWE_NONCE_TTL_MS}. */
  issueNonce(): string {
    const nonce = generateSiweNonce();
    const now = this.now();
    this.nonces.insert(nonce, now, now + SIWE_NONCE_TTL_MS);
    return nonce;
  }

  /** Parses and verifies a signed SIWE message; consumes its nonce. */
  async verify(message: string, signature: Hex): Promise<SiweVerifyResult> {
    let parsed: ReturnType<typeof parseSiweMessage>;
    try {
      parsed = parseSiweMessage(message);
    } catch (e) {
      return { ok: false, code: 'invalid_message', message: `unparseable SIWE message: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (parsed.address === undefined || parsed.chainId === undefined || parsed.nonce === undefined || parsed.domain === undefined || parsed.uri === undefined) {
      return { ok: false, code: 'invalid_message', message: 'SIWE message lacks address, chainId, nonce, domain or uri' };
    }
    if (parsed.domain !== this.options.domain) {
      return { ok: false, code: 'bad_domain', message: `SIWE domain ${JSON.stringify(parsed.domain)} does not match ${JSON.stringify(this.options.domain)}` };
    }
    if (!isSupportedChainId(parsed.chainId)) return { ok: false, code: 'bad_chain', message: `unsupported chain id ${parsed.chainId}` };
    const time = new Date(this.now());
    if (!validateSiweMessage({ message: parsed, domain: this.options.domain, nonce: parsed.nonce, time })) {
      return { ok: false, code: 'expired', message: 'SIWE message is expired, not yet valid or inconsistent' };
    }
    if (!this.nonces.consume(parsed.nonce, this.now())) return { ok: false, code: 'bad_nonce', message: 'unknown, used or expired nonce' };
    const full = parsed as SiweMessage;
    let valid = false;
    try {
      valid = await this.verifier({ message, signature, parsed: full });
    } catch {
      valid = false;
    }
    if (!valid) return { ok: false, code: 'bad_signature', message: 'signature does not match the message address' };
    return { ok: true, address: full.address, chainId: full.chainId };
  }
}
