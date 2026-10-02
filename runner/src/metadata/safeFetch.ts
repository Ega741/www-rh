/**
 * Best-effort HTTP(S) GET for metadata documents (`docs/SPEC.md` §4.1 `metadata/`): 5 s timeout,
 * 64 KB cap, the browser egress filter on the URL and on every redirect hop (≤ 3), and the
 * connection pinned to the address that passed the check (no DNS-rebinding window).
 *
 * The timeout is an absolute deadline over every hop: a timer destroys the request when it
 * expires, so a server dripping one byte at a time cannot keep the fetch alive (the socket idle
 * timeout is kept as well).
 *
 * @module metadata/safeFetch
 */
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import type { EgressFilter } from '../browser/egress.js';

/** Fetch limits. */
export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

/** Signature of {@link safeFetchText} (injectable for tests). */
export type FetchText = (url: string, egress: EgressFilter, opts?: SafeFetchOptions) => Promise<string>;

function pinnedLookup(address: string): LookupFunction {
  const family = address.includes(':') ? 6 : 4;
  return ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options.all === true) callback(null, [{ address, family }]);
    else callback(null, address, family);
  }) as LookupFunction;
}

function getOnce(url: URL, address: string, timeoutMs: number, maxBytes: number, deadlineMs: number): Promise<{ status: number; location: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    let deadline: NodeJS.Timeout | undefined;
    const done = <T>(fn: (v: T) => void) => (v: T): void => {
      clearTimeout(deadline);
      fn(v);
    };
    resolve = done(resolve);
    reject = done(reject);
    const req = mod.request(
      url,
      { method: 'GET', lookup: pinnedLookup(address), headers: { accept: 'application/json, text/plain;q=0.5', 'user-agent': 'www-rh-runner' }, timeout: timeoutMs },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ status, location: res.headers.location, body: '' });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            const err = new Error(`response exceeds ${maxBytes} bytes`);
            reject(err);
            req.destroy(err);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status, location: undefined, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
        res.on('close', () => {
          if (!res.complete) reject(new Error('connection closed before the response completed'));
        });
      },
    );
    // absolute deadline (the `timeout` option above is only the socket idle timeout)
    deadline = setTimeout(() => {
      const err = new Error(`timeout after ${timeoutMs} ms (deadline)`);
      reject(err);
      req.destroy(err);
    }, Math.max(1, deadlineMs));
    deadline.unref();
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}

/** GETs `url` as text under the egress policy. */
export const safeFetchText: FetchText = async (raw, egress, opts = {}) => {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const maxBytes = opts.maxBytes ?? 65_536;
  const deadline = Date.now() + timeoutMs;
  let current = raw;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
    const verdict = await egress.checkUrl(current);
    if (!verdict.ok) throw new Error(`blocked: ${verdict.reason}`);
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`timeout after ${timeoutMs} ms`);
    const res = await getOnce(verdict.url, verdict.addresses[0] as string, left, maxBytes, left);
    if (res.status >= 300 && res.status < 400) {
      if (res.location === undefined) throw new Error(`redirect ${res.status} without location`);
      current = new URL(res.location, verdict.url).toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    return res.body;
  }
  throw new Error('too many redirects');
};
