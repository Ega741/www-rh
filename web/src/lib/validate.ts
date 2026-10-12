/** Input validation for forms (Solana public keys, https URLs, hour counts, names). */
import { isBase58Pubkey } from '@beagle/shared/solana';

/** Parses a typed public key (trimmed, base58, 32 bytes). `undefined` when invalid. */
export function parseAddressInput(input: string): string | undefined {
  const v = input.trim();
  return isBase58Pubkey(v) ? v : undefined;
}

/** `true` for an absolute `https:` URL (BYOK `baseUrl`, SPEC §5.9). Empty strings are not URLs. */
export function isHttpsUrl(input: string): boolean {
  try {
    const u = new URL(input.trim());
    return u.protocol === 'https:' && u.hostname !== '';
  } catch {
    return false;
  }
}

/** Result of {@link parseHours}. */
export type ParsedHours = { ok: true; hours: number } | { ok: false; error: string };

/** Parses an integer hour count in `[1, max]`. */
export function parseHours(input: string, max: number): ParsedHours {
  const v = input.trim();
  if (v === '') return { ok: false, error: 'Enter a number of hours' };
  if (!/^\d+$/.test(v)) return { ok: false, error: 'Hours must be a whole number' };
  const n = Number(v);
  if (n < 1) return { ok: false, error: 'At least 1 hour' };
  if (n > max) return { ok: false, error: `At most ${max} hours` };
  return { ok: true, hours: n };
}

/** Parses a key / provider display name: trimmed, 1–64 characters. */
export function parseName(input: string, fallback = 'default'): string | undefined {
  const v = input.trim();
  if (v === '') return fallback;
  return v.length <= 64 ? v : undefined;
}
