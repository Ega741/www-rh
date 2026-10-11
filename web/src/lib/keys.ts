/** API key display helpers (SPEC §1: `bgl_` + 43 base64url chars; prefix = first 12 chars). */

const KEY_RE = /^bgl_[A-Za-z0-9_-]{43}$/;

/** `true` when `s` looks like a full Beagle API key. */
export function isApiKey(s: string): boolean {
  return KEY_RE.test(s);
}

/** First 12 characters (`bgl_xxxxxxxx`), the stored display prefix. */
export function keyPrefix(key: string): string {
  return key.slice(0, 12);
}

/** Masked display of a stored key from its prefix: `bgl_xxxxxxxx••••••••`. */
export function maskKey(prefix: string, dots = 8): string {
  return `${prefix}${'•'.repeat(dots)}`;
}

/** Shows the full key only while `revealed`, else the masked prefix. */
export function displayKey(key: string, revealed: boolean): string {
  return revealed ? key : maskKey(keyPrefix(key));
}

/** Replaces any full API key inside `text` with its masked prefix (safe for logs / toasts). */
export function redactKeys(text: string): string {
  return text.replace(/bgl_[A-Za-z0-9_-]{43}/g, (m) => maskKey(keyPrefix(m)));
}
