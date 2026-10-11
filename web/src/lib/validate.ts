/** Input validation for forms (addresses, https URLs, hour counts). */
import { getAddress, isAddress, type Address } from 'viem';

/** Parses a typed address (any case, EIP-55 enforced when mixed case). `undefined` when invalid. */
export function parseAddressInput(input: string): Address | undefined {
  const v = input.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return undefined;
  const lower = v.toLowerCase();
  if (v === lower || v === v.toUpperCase()) return getAddress(lower);
  return isAddress(v, { strict: true }) ? getAddress(v) : undefined;
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
