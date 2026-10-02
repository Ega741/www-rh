/**
 * One Chromium per process (relaunched on disconnect) and one `BrowserContext` per mind in an LRU
 * of `2 × MAX_CONCURRENT_MINDS` (`docs/SPEC.md` §4.1 `browser/`). Every context applies the egress
 * filter through `context.route` (with manual redirect validation, since route handlers are not
 * re-invoked for redirect hops) and `context.routeWebSocket`; Chromium additionally sends all
 * traffic through the local {@link EgressProxy} and never sends UDP outside it (WebRTC).
 *
 * Memory: `route.fetch()` buffers bodies inside this process until `APIResponse.dispose()`. Fetched
 * responses are therefore disposed right after `route.fulfill`, bodies above
 * {@link MAX_RESPONSE_BYTES} are refused, and — when the egress proxy is active (it re-checks and
 * pins every hop) — sub-resources are not fetched here at all (`route.continue()`): only navigation
 * requests go through `route.fetch` so a redirect to a blocked target aborts the navigation.
 * Contexts are recycled after {@link RECYCLE_AFTER_USES} ticks or {@link RECYCLE_AFTER_MS}, and an
 * unusable session's context is always closed before a new one is created.
 *
 * @module browser/pool
 */
import { chromium, type APIResponse, type Browser, type BrowserContext, type Route } from 'playwright';
import { errorMessage, type Logger } from '../log.js';
import type { EgressFilter } from './egress.js';
import { EgressProxy } from './egressProxy.js';
import { MindBrowser, VIEWPORT, withTimeout } from './mindBrowser.js';

/** Largest response body passed to the page through `route.fetch`. */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** A mind's context is recreated after this many ticks used it… */
export const RECYCLE_AFTER_USES = 25;
/** …or after this long. */
export const RECYCLE_AFTER_MS = 60 * 60_000;

/** Options of {@link BrowserPool}. */
export interface BrowserPoolOptions {
  headless: boolean;
  maxContexts: number;
  /** Route Chromium through the egress proxy (default true). */
  useProxy?: boolean;
  /** Recycling thresholds (defaults {@link RECYCLE_AFTER_USES} / {@link RECYCLE_AFTER_MS}). */
  recycleAfterUses?: number;
  recycleAfterMs?: number;
  /** Per-operation timeout of each session ({@link MindBrowser}). */
  opTimeoutMs?: number;
}

/** Chromium command-line switches (exported for tests). */
export function chromiumLaunchArgs(proxyUrl: string | null): string[] {
  return [
    // WebRTC must not open UDP sockets that bypass the egress proxy (STUN/TURN to internal hosts, IP leaks)
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    ...(proxyUrl !== null ? ['--proxy-bypass-list=<-loopback>'] : []),
  ];
}

/** Options of {@link installEgressRoutes}. */
export interface EgressRouteOptions {
  /** Chromium uses the egress proxy: sub-resources may stream through it (`route.continue()`). */
  proxied?: boolean;
  maxResponseBytes?: number;
}

/** Applies the egress filter to every request of `context` (exported for tests). */
export async function installEgressRoutes(context: BrowserContext, egress: EgressFilter, log: Logger, opts: EgressRouteOptions = {}): Promise<void> {
  const maxBytes = opts.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  await context.route('**/*', async (route: Route) => {
    const request = route.request();
    const url = request.url();
    const verdict = await egress.checkUrl(url);
    if (!verdict.ok) {
      log.debug('request blocked', { url, reason: verdict.reason });
      await route.abort('blockedbyclient').catch(() => undefined);
      return;
    }
    if (opts.proxied === true && !request.isNavigationRequest()) {
      // the egress proxy re-checks every hop and connects to the checked address: nothing to buffer here
      await route.continue().catch(() => undefined);
      return;
    }
    let response: APIResponse | null = null;
    try {
      response = await route.fetch({ maxRedirects: 0, timeout: 20_000 });
      const status = response.status();
      const headers = response.headers();
      if (status >= 300 && status < 400) {
        const location = headers['location'];
        if (location !== undefined) {
          const next = await egress.checkUrl(new URL(location, url).toString());
          if (!next.ok) {
            log.debug('redirect blocked', { url, location, reason: next.reason });
            await route.abort('blockedbyclient').catch(() => undefined);
            return;
          }
        }
      }
      const declared = Number(headers['content-length'] ?? Number.NaN);
      const size = Number.isFinite(declared) ? declared : (await response.body()).length;
      if (size > maxBytes) {
        log.debug('response too large', { url, size, maxBytes });
        await route.abort('failed').catch(() => undefined);
        return;
      }
      await route.fulfill({ response });
    } catch (err) {
      log.debug('request failed', { url, error: errorMessage(err) });
      await route.abort('failed').catch(() => undefined);
    } finally {
      // route.fetch keeps the body in this process until disposed
      await response?.dispose().catch(() => undefined);
    }
  });
  await context.routeWebSocket(/.*/, async (ws) => {
    const verdict = await egress.checkUrl(ws.url().replace(/^ws/i, 'http'));
    if (!verdict.ok) {
      await ws.close({ code: 1008, reason: 'blocked' }).catch(() => undefined);
      return;
    }
    ws.connectToServer();
  });
}

/** Chromium + per-mind contexts. */
export class BrowserPool {
  #browser: Browser | null = null;
  #launching: Promise<Browser> | null = null;
  readonly #sessions = new Map<string, MindBrowser>();
  #proxy: EgressProxy | null = null;
  #closed = false;

  constructor(
    private readonly opts: BrowserPoolOptions,
    private readonly egress: EgressFilter,
    private readonly log: Logger,
  ) {}

  async #launch(): Promise<Browser> {
    if (this.#browser?.isConnected() === true) return this.#browser;
    this.#launching ??= (async () => {
      let proxyUrl: string | null = null;
      if (this.opts.useProxy !== false) {
        this.#proxy ??= new EgressProxy(this.egress, this.log.child('proxy'));
        proxyUrl = this.#proxy.url ?? (await this.#proxy.start());
      }
      const browser = await chromium.launch({
        headless: this.opts.headless,
        args: chromiumLaunchArgs(proxyUrl),
        ...(proxyUrl !== null ? { proxy: { server: proxyUrl } } : {}),
      });
      browser.on('disconnected', () => {
        this.#browser = null;
        this.#sessions.clear();
        if (!this.#closed) this.log.warn('chromium disconnected; it will be relaunched on the next tick');
      });
      this.#browser = browser;
      return browser;
    })().finally(() => {
      this.#launching = null;
    });
    return this.#launching;
  }

  /** The mind's browser session (created lazily, LRU-refreshed, recycled when old). */
  async session(token: string): Promise<MindBrowser> {
    const key = token.toLowerCase();
    const existing = this.#sessions.get(key);
    let resumeUrl: string | null = null;
    if (existing !== undefined) {
      const usable = !existing.closed && !existing.page.isClosed();
      const worn = existing.uses >= (this.opts.recycleAfterUses ?? RECYCLE_AFTER_USES) || Date.now() - existing.createdAt >= (this.opts.recycleAfterMs ?? RECYCLE_AFTER_MS);
      if (usable && !worn) {
        this.#sessions.delete(key);
        this.#sessions.set(key, existing);
        existing.uses++;
        return existing;
      }
      if (usable) resumeUrl = existing.currentUrl();
      this.#sessions.delete(key);
      // never leak the previous context (a crashed / closed page, or a recycled one)
      await existing.close();
    }
    const browser = await this.#launch();
    const context = await browser.newContext({ viewport: VIEWPORT, acceptDownloads: false, serviceWorkers: 'block', permissions: [] });
    await installEgressRoutes(context, this.egress, this.log, { proxied: this.opts.useProxy !== false });
    const page = await context.newPage();
    const session = new MindBrowser(context, page, this.egress, this.log.child(key.slice(0, 10)), this.opts.opTimeoutMs !== undefined ? { opTimeoutMs: this.opts.opTimeoutMs } : {});
    session.installPopupCloser();
    session.uses = 1;
    this.#sessions.set(key, session);
    while (this.#sessions.size > this.opts.maxContexts) {
      const [oldestKey, oldest] = this.#sessions.entries().next().value as [string, MindBrowser];
      this.#sessions.delete(oldestKey);
      void oldest.close();
    }
    if (resumeUrl !== null && /^https?:\/\//i.test(resumeUrl)) await session.restore(resumeUrl).catch(() => undefined);
    return session;
  }

  /** Closes and forgets the mind's context (after a timeout); the next tick starts on `about:blank`. */
  async reset(token: string): Promise<void> {
    const key = token.toLowerCase();
    const s = this.#sessions.get(key);
    this.#sessions.delete(key);
    await s?.close();
  }

  /** Closes every context, the browser and the proxy. */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#sessions.values()].map((s) => s.close()));
    this.#sessions.clear();
    if (this.#browser !== null) await withTimeout(this.#browser.close(), 10_000, 'browser.close').catch(() => undefined);
    this.#browser = null;
    await this.#proxy?.close();
  }
}
