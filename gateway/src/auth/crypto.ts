/**
 * Cryptographic helpers: SHA-256 hashing, random tokens, constant-time comparison and the BYOK
 * AES-256-GCM keyring (SPEC §5.3: random 12-byte IV, AAD = `workspace|provider`).
 *
 * @module auth/crypto
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/** Hex SHA-256 of `input` (UTF-8). */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Hex HMAC-SHA-256 of `input` with `secret`. */
export function hmacHex(secret: string, input: string): string {
  return createHmac('sha256', secret).update(input, 'utf8').digest('hex');
}

/** `n` random bytes as base64url (no padding). */
export function randomBase64Url(n: number): string {
  return randomBytes(n).toString('base64url');
}

/** `n` random bytes as hex. */
export function randomHex(n: number): string {
  return randomBytes(n).toString('hex');
}

/** A fresh UUIDv4. */
export function uuid(): string {
  return randomUUID();
}

/** Constant-time string equality (hashes both sides so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** Ciphertext triple stored in `provider_keys`. */
export interface Encrypted {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
}

/** Thrown when the keyring is missing or a ciphertext fails authentication. */
export class KeyringError extends Error {
  override readonly name = 'KeyringError';
}

/** AES-256-GCM keyring bound to a 32-byte master key. */
export class Keyring {
  constructor(private readonly masterKey: Buffer) {
    if (masterKey.length !== 32) throw new KeyringError(`KEYRING_MASTER_KEY must be 32 bytes (got ${masterKey.length})`);
  }

  /** Encrypts `plaintext` with AAD `workspace|provider`. */
  encrypt(plaintext: string, workspace: string, provider: string): Encrypted {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv);
    cipher.setAAD(Buffer.from(`${workspace.toLowerCase()}|${provider}`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ciphertext, iv, tag: cipher.getAuthTag() };
  }

  /** Decrypts; throws {@link KeyringError} when the tag or AAD does not match. */
  decrypt(enc: Encrypted, workspace: string, provider: string): string {
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.masterKey, Buffer.from(enc.iv));
      decipher.setAAD(Buffer.from(`${workspace.toLowerCase()}|${provider}`, 'utf8'));
      decipher.setAuthTag(Buffer.from(enc.tag));
      return Buffer.concat([decipher.update(Buffer.from(enc.ciphertext)), decipher.final()]).toString('utf8');
    } catch (e) {
      throw new KeyringError(`decryption failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
