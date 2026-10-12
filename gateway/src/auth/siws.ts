/**
 * Sign-In-With-Solana (SPEC §5.3): nonces (10 min, single use), message parsing and field
 * validation through `@beagle/shared/siws`, then an Ed25519 check of the exact UTF-8 text with
 * tweetnacl. Signatures arrive as base58 (87–88 chars) or standard base64 (88 chars, `==`).
 *
 * @module auth/siws
 */
import { parseSiwsMessage, SiwsParseError, validateSiwsFields, type SiwsFields, type SiwsProblemCode } from '@beagle/shared/siws';
import { decodeBase58, isBase58Pubkey } from '@beagle/shared/solana';
import nacl from 'tweetnacl';
import type { NonceRepo } from '../db/repos.js';
import { randomBase64Url } from './crypto.js';

/** Nonce lifetime. */
export const SIWS_NONCE_TTL_MS = 10 * 60 * 1000;

/** Failure codes of {@link SiwsService.verify} (`siws_<code>` on the wire). */
export type SiwsVerifyCode = SiwsProblemCode | 'invalid_message' | 'invalid_signature' | 'invalid_public_key' | 'bad_signature' | 'nonce_used';

/** Result of {@link SiwsService.verify}. */
export type SiwsVerifyResult = { ok: true; address: string; fields: SiwsFields } | { ok: false; code: SiwsVerifyCode; message: string };

/** Options of {@link SiwsService}. */
export interface SiwsServiceOptions {
  /** `host(PUBLIC_URL)`. */
  domain: string;
  /** `PUBLIC_URL` (the message `uri` must share its origin). */
  uri: string;
  /** `clusterCaip(CLUSTER)`. */
  chainId: string;
  now?: () => number;
}

const BASE64_SIGNATURE_RE = /^[A-Za-z0-9+/]{86}==$/;

/** Decodes a 64-byte signature given as base58 or base64; `undefined` for anything else. */
export function decodeSignature(input: string): Uint8Array | undefined {
  const text = input.trim();
  if (BASE64_SIGNATURE_RE.test(text)) {
    const bytes = Uint8Array.from(Buffer.from(text, 'base64'));
    return bytes.length === 64 ? bytes : undefined;
  }
  const bytes = decodeBase58(text);
  return bytes !== undefined && bytes.length === 64 ? bytes : undefined;
}

const encoder = new TextEncoder();

/** Nonce issuance and SIWS verification. */
export class SiwsService {
  private readonly now: () => number;

  constructor(
    private readonly nonces: NonceRepo,
    private readonly options: SiwsServiceOptions,
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Issues a nonce (22 chars of `[A-Za-z0-9_-]`) valid for {@link SIWS_NONCE_TTL_MS}. */
  issueNonce(): string {
    const nonce = randomBase64Url(16);
    const now = this.now();
    this.nonces.insert(nonce, now, now + SIWS_NONCE_TTL_MS);
    return nonce;
  }

  /** Drops expired nonces (called by the housekeeping loop so an unauthenticated flood cannot grow the table). */
  purgeExpired(): number {
    return this.nonces.purgeExpired(this.now());
  }

  /**
   * Parses and validates `message` against the gateway's domain / uri / chain id, checks that it
   * names `publicKey`, verifies `signature` over the UTF-8 bytes and consumes the nonce (single use).
   */
  verify(message: string, signature: string, publicKey: string): SiwsVerifyResult {
    if (!isBase58Pubkey(publicKey)) return { ok: false, code: 'invalid_public_key', message: 'publicKey is not a base58 Solana public key' };
    let fields: SiwsFields;
    try {
      fields = parseSiwsMessage(message);
    } catch (e) {
      return { ok: false, code: 'invalid_message', message: `unparseable SIWS message: ${e instanceof SiwsParseError ? e.message : String(e)}` };
    }
    const now = this.now();
    const problems = validateSiwsFields(fields, {
      domain: this.options.domain,
      uri: this.options.uri,
      chainId: this.options.chainId,
      address: publicKey,
      now,
      nonceOk: (nonce) => this.nonces.peek(nonce, now),
    });
    const first = problems[0];
    if (first !== undefined) return { ok: false, code: first.code, message: first.message };
    const sig = decodeSignature(signature);
    if (sig === undefined) return { ok: false, code: 'invalid_signature', message: 'signature must be 64 bytes in base58 or base64' };
    const pk = decodeBase58(publicKey) as Uint8Array;
    let valid = false;
    try {
      valid = nacl.sign.detached.verify(encoder.encode(message), sig, pk);
    } catch {
      valid = false;
    }
    if (!valid) return { ok: false, code: 'bad_signature', message: 'signature does not verify for publicKey over the message' };
    if (!this.nonces.consume(fields.nonce as string, now)) return { ok: false, code: 'nonce_used', message: 'nonce was already used' };
    return { ok: true, address: fields.address, fields };
  }
}
