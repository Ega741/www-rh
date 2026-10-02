/**
 * Decodes `data:application/json;base64,…` metadata URIs in the browser, so a coin created while
 * the runner was unreachable (W2 fallback) still shows its persona and description when the
 * runner cannot resolve it.
 *
 * @module lib/dataUri
 */
import { isObject } from './json';

const PREFIX = 'data:application/json;base64,';

/** Parsed JSON object of a base64 JSON data URI, or `null` when not one / malformed. */
export function decodeJsonDataUri(uri: string): Record<string, unknown> | null {
  if (!uri.startsWith(PREFIX)) return null;
  try {
    const binary = atob(uri.slice(PREFIX.length));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
